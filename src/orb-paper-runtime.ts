import { EntrySkip, OrbOptionsEngine, parseOrbOptionsConfig, parseOpeningRange, selectOrbCall,
  type OrbOptionsConfig, type OrbSnapshot, type OrbIntent, type CallQuote, type OrbCallContract } from "./orb-options.ts";
import { CalendarCoverageError, isEarlyClose, isTradingDay } from "./daily-history.ts";
import type { PaperMarket } from "./paper-market.ts";
import type { PaperRuntime, PaperEvent, PaperPosition, PaperControl } from "./paper-runtime.ts";

export function sessionTimes(date: string) {
  if (!isTradingDay(date)) throw new Error("Unsupported market session");
  const noon = Date.parse(date + "T12:00:00Z");
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hourCycle: "h23" }).format(noon));
  const open = Date.parse(date + "T00:00:00Z") + (9.5 + 12 - hour) * 3600000;
  return { open, close: open + (isEarlyClose(date) ? 3.5 : 6.5) * 3600000 };
}
type Holding = { contract: OrbCallContract; entryPrice: number; mark: CallQuote | null };
export interface OrbPaperCheckpoint { engine: OrbSnapshot; holdings: Record<string, Holding>; loaded: boolean;
  nextMark: number; committedCents: number; realizedPnlCents: number; complete: boolean; lastQuoteAt: string | null; resumed: boolean;
  protectiveExits: Record<string, "protective_stop" | "session_close"> }
export class OrbPaperRuntime implements PaperRuntime {
  #config: OrbOptionsConfig; #market: PaperMarket; #clock: () => number; #engine: OrbOptionsEngine;
  #saved: Omit<OrbPaperCheckpoint, "engine">; #session: { open: number; close: number }; #resumeNotes: string[] = [];
  constructor(raw: unknown, market: PaperMarket, clock = Date.now, checkpoint?: unknown) {
    this.#config = parseOrbOptionsConfig(raw); this.#market = market; this.#clock = clock;
    this.#engine = new OrbOptionsEngine(this.#config); this.#session = sessionTimes(this.#config.date);
    this.#saved = { holdings: {}, loaded: false, nextMark: 0,
      committedCents: 0, realizedPnlCents: 0, complete: false, lastQuoteAt: null, resumed: false, protectiveExits: {} };
    if (checkpoint) {
      const s = checkpoint as OrbPaperCheckpoint;
      if (!s.holdings || !s.protectiveExits || Object.entries(s.protectiveExits).some(([symbol, reason]) =>
        !this.#config.symbols.includes(symbol) || !["protective_stop", "session_close"].includes(reason)) ||
        !Number.isSafeInteger(s.committedCents) || s.committedCents < 0 || s.committedCents > this.#config.budgetCentsPerDay ||
        !Number.isSafeInteger(s.realizedPnlCents)) throw new Error("Invalid paper checkpoint");
      this.#engine.restore(s.engine);
      for (const [symbol, state] of Object.entries(s.engine.symbols)) if (state.position) {
        const h = s.holdings[symbol];
        if (!h || h.contract.id !== state.position.contractId || !(h.entryPrice > 0) || h.contract.symbol !== symbol) throw new Error("Saved contract mismatch");
      }
      const { engine: _, ...rest } = structuredClone(s); this.#saved = { ...rest, resumed: true, complete: false };
      // A gap may hide a low breach. Recovery manages existing positions only.
      for (const h of Object.values(this.#saved.holdings)) h.mark = null;
      // Recovery manages prior positions only, so symbols still watching are done for the day, and say so.
      for (const [symbol, state] of Object.entries(this.#engine.snapshot().symbols))
        if (state.status === "watching") { this.#engine.disqualify(symbol, "resumed_management_only"); this.#resumeNotes.push(symbol); }
    }
  }
  checkpoint(): OrbPaperCheckpoint { return { ...structuredClone(this.#saved), engine: this.#engine.snapshot() }; }
  #validOption(q: CallQuote | undefined): q is CallQuote {
    if (!q || !(q.bid > 0 && q.ask >= q.bid && Number.isFinite(q.ask))) return false;
    return [q.updatedAt, q.retrievedAt].every(t => { const age = this.#clock() - Date.parse(t); return Number.isFinite(age) && age >= 0 && age <= this.#config.maxQuoteAgeMs; });
  }
  #fresh(q: Awaited<ReturnType<PaperMarket["quotes"]>>[number] | undefined) {
    const age = q?.tradeAt ? this.#clock() - Date.parse(q.tradeAt) : Infinity;
    return !!q && q.fresh && q.regularSession && q.state === "active" && Number.isFinite(q.price) && q.price! > 0 && age >= 0 && age <= this.#config.maxQuoteAgeMs;
  }
  async #handle(intent: OrbIntent): Promise<PaperEvent[]> {
    if (intent.kind === "enter_calls") {
      try {
        const catalog = await this.#market.calls(intent.symbol, this.#config.date);
        const stock = (await this.#market.quotes([intent.symbol]))[0];
        if (stock?.symbol !== intent.symbol || !this.#fresh(stock)) throw new Error("Stale breakout quote");
        if (stock!.price! <= intent.range.high) throw new EntrySkip("breakout_reversed");
        if (this.#clock() >= this.#session.close - 60000) throw new EntrySkip("too_close_to_session_end");
        // Committed premium never decreases (proceeds never replenish the budget), so the day cap is spent, not recycled.
        const capCents = Math.min(this.#config.budgetCentsPerPosition, this.#config.budgetCentsPerDay - this.#saved.committedCents);
        const selected = selectOrbCall(catalog.contracts, catalog.quotes, intent.symbol, catalog.expiration, stock!.price!, this.#config, this.#clock(), capCents);
        if (!selected || this.#saved.committedCents + selected.committedCents > this.#config.budgetCentsPerDay) throw new EntrySkip("no_affordable_eligible_call");
        this.#engine.confirmEntry(intent.symbol, selected.contract.id, selected.quantity, stock!.price!);
        this.#saved.holdings[intent.symbol] = { contract: selected.contract, entryPrice: selected.limitPrice, mark: null };
        this.#saved.committedCents += selected.committedCents;
        return [{ type: "option_selection", data: { symbol: intent.symbol, contracts: catalog.contracts, quotes: catalog.quotes, selected, stock } },
          { type: "paper_entry", data: { symbol: intent.symbol, setup: intent.setup, stockPrice: stock!.price,
          strike: selected.contract.strike, expiration: selected.contract.expiration, quantity: selected.quantity,
          assumedFill: selected.limitPrice, committedCents: selected.committedCents, fillGuaranteed: false } }];
      } catch (error) {
        // Rule decisions and calendar gaps are named, so a review can tell a policy skip from a data problem.
        const reason = error instanceof EntrySkip ? error.reason : error instanceof CalendarCoverageError ? "calendar_not_covered" : "data_unavailable";
        const detail = reason === "data_unavailable" ? { detail: String((error as Error)?.message ?? error).slice(0, 200) } : {};
        this.#engine.failEntry(intent.symbol); return [{ type: "entry_skipped", data: { symbol: intent.symbol, reason, ...detail } }];
      }
    }
    if (intent.reason === "protective_stop" || intent.reason === "session_close") this.#saved.protectiveExits[intent.symbol] = intent.reason;
    try {
      const quote = (await this.#market.optionQuotes([intent.contractId])).find(q => q.id === intent.contractId);
      if (!this.#validOption(quote)) throw new Error("Stale option bid");
      const h = this.#saved.holdings[intent.symbol]!;
      const pnlCents = Math.round((quote.bid - h.entryPrice) * 10000 * intent.quantity);
      this.#engine.confirmSale(intent.symbol, intent.quantity); h.mark = quote; this.#saved.realizedPnlCents += pnlCents;
      if (this.#engine.snapshot().symbols[intent.symbol]!.status === "closed") delete this.#saved.protectiveExits[intent.symbol];
      return [{ type: "paper_sale", data: { symbol: intent.symbol, quantity: intent.quantity, reason: intent.reason,
        stockPrice: intent.stockPrice, quote, assumedFill: quote.bid, realizedPnlCents: pnlCents, fillGuaranteed: false, feesExcluded: true } }];
    } catch { this.#engine.failSale(intent.symbol); return [{ type: "sale_deferred", data: { symbol: intent.symbol, reason: "fresh_option_bid_unavailable" } }]; }
  }
  async step(): Promise<PaperEvent[]> {
    const now = this.#clock(), { open, close } = this.#session, c = this.#config; const events: PaperEvent[] = [];
    if (this.#saved.complete || now < open + 120000) return events;
    for (const symbol of this.#resumeNotes.splice(0)) events.push({ type: "setup_disqualified", data: { symbol, reason: "resumed_management_only" } });
    if (now >= close) { this.#saved.complete = true; return [{ type: "session_ended", data: { remainingPositions: this.view().positions.length, noAutomaticCarryOrExercise: true } }]; }
    if (!this.#saved.loaded) {
      const bars = await this.#market.bars(c.symbols, open - c.includePremarketLeadMinutes * 60000, open + 120000, c.includePremarketLeadMinutes > 0);
      for (const symbol of c.symbols) {
        const late = this.#saved.resumed || this.#clock() > open + 120000 + c.maxObservationGapMs;
        try {
          if (late) throw new Error("Opening monitoring gap");
          const range = parseOpeningRange(bars, symbol, open, 2, c.includePremarketLeadMinutes);
          this.#engine.setRange(symbol, range); events.push({ type: "opening_range", data: { symbol, range } });
        } catch {
          const reason = late ? "late_first_quote" : "range_unavailable";
          this.#engine.failRange(symbol, reason); events.push({ type: "setup_disqualified", data: { symbol, reason } });
        }
      }
      this.#saved.loaded = true;
    }
    for (const symbol of this.#engine.closeEntryWindow(now)) events.push({ type: "setup_disqualified", data: { symbol, reason: "entry_window_closed" } });
    const quotes = await this.#market.quotes(c.symbols);
    if (quotes.length !== c.symbols.length || new Set(quotes.map(q => q.symbol)).size !== quotes.length || quotes.some(q => !c.symbols.includes(q.symbol)))
      throw new Error("Incomplete or mismatched quote batch");
    for (const q of quotes.sort((a, b) => (a.tradeAt ?? "").localeCompare(b.tradeAt ?? "") || a.symbol.localeCompare(b.symbol))) {
      events.push({ type: "quote", data: q });
      if (!this.#fresh(q)) continue;
      this.#saved.lastQuoteAt = q.tradeAt;
      const state = this.#engine.snapshot().symbols[q.symbol];
      if (!state) throw new Error("Foreign quote");
      if (state.status === "watching" && state.lastObservationMs === null && this.#clock() > open + 120000 + c.maxObservationGapMs) {
        // Never infer an unobserved opening-range path from a late first quote.
        this.#engine.disqualify(q.symbol, "late_first_quote");
      }
      if (this.#saved.resumed && state.status !== "open") continue;
      // Flatten simulated positions before the close, without inventing a fill if quotes fail.
      if ((now >= close - 60000 || this.#saved.protectiveExits[q.symbol]) && state.position && state.status === "open") {
        for (const intent of this.#engine.requestPositionSale(q.symbol, this.#saved.protectiveExits[q.symbol] ?? "session_close", state.position.remainingQuantity, state.position.remainingQuantity, q.price!, Date.parse(q.tradeAt!)))
          events.push(...await this.#handle(intent));
      } else for (const intent of this.#engine.observe(q.symbol, q.price!, Date.parse(q.tradeAt!), this.#clock())) events.push(...await this.#handle(intent));
      // Journal the rule that ended watching (opening low, gap, late first quote) so every skip is explainable.
      const after = this.#engine.snapshot().symbols[q.symbol]!;
      if (state.status === "watching" && after.status === "disqualified") events.push({ type: "setup_disqualified", data: { symbol: q.symbol, reason: after.endReason } });
    }
    if (now >= this.#saved.nextMark) {
      for (const p of this.view().positions) {
        try {
          const mark = (await this.#market.optionQuotes([p.contractId])).find(q => q.id === p.contractId);
          this.#saved.holdings[p.symbol]!.mark = this.#validOption(mark) ? mark : null;
          events.push({ type: "option_mark", data: { symbol: p.symbol, quote: this.#saved.holdings[p.symbol]!.mark } });
        } catch { this.#saved.holdings[p.symbol]!.mark = null; }
      }
      this.#saved.nextMark = now + 5000;
    }
    return events;
  }
  async control(command: PaperControl): Promise<PaperEvent[]> {
    if (this.#clock() < this.#session.open || this.#clock() >= this.#session.close || !["trim", "close"].includes(command.action)) throw new Error("Regular session required");
    const p = this.view().positions.find(p => p.symbol === command.symbol);
    if (!p || p.quantity !== command.expectedQuantity || !Number.isInteger(command.quantity) || command.quantity < 1 || command.quantity > p.quantity ||
      (command.action === "close" && command.quantity !== p.quantity)) throw new Error("Position changed; request a new review");
    const quote = (await this.#market.quotes([command.symbol]))[0];
    if (quote?.symbol !== command.symbol || !this.#fresh(quote)) throw new Error("Fresh regular-session quote required");
    const intents = this.#engine.requestPositionSale(command.symbol, command.action === "close" ? "user_close" : "user_trim",
      command.quantity, command.expectedQuantity, quote!.price!, Date.parse(quote!.tradeAt!));
    if (intents.length !== 1) throw new Error("Position command rejected");
    return this.#handle(intents[0]!);
  }
  view() {
    const snapshot = this.#engine.snapshot(); const positions: PaperPosition[] = [];
    for (const [symbol, state] of Object.entries(snapshot.symbols)) {
      if (state.status !== "open" || !state.position) continue;
      const h = this.#saved.holdings[symbol]!, p = state.position; const mark = this.#validOption(h.mark ?? undefined) ? h.mark : null;
      positions.push({ symbol, contractId: h.contract.id, strike: h.contract.strike, expiration: h.contract.expiration,
        quantity: p.remainingQuantity, entryPrice: h.entryPrice, entryStockPrice: p.entryStockPrice,
        markBid: mark?.bid ?? null, markAt: mark?.updatedAt ?? null, stop: state.range!.low * .999 });
    }
    return { positions, committedCents: this.#saved.committedCents, realizedPnlCents: this.#saved.realizedPnlCents,
      unrealizedPnlCents: positions.some(p => p.markBid === null) ? null : positions.reduce((sum, p) => sum + Math.round((p.markBid! - p.entryPrice) * 10000 * p.quantity), 0),
      lastQuoteAt: this.#saved.lastQuoteAt, complete: this.#saved.complete, detail: snapshot };
  }
}
