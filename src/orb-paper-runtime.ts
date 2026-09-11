import { EntrySkip, OrbOptionsEngine, backstopPrice, parseOrbOptionsConfig, parseOpeningRange, selectOrbCall, type OpeningRange,
  type OrbOptionsConfig, type OrbSnapshot, type OrbIntent, type CallQuote, type OrbCallContract, type SaleReason } from "./orb-options.ts";
import { CalendarCoverageError, sessionTimes } from "./daily-history.ts";
import type { PaperMarket } from "./paper-market.ts";
import { StepError, type PaperRuntime, type PaperEvent, type PaperPosition, type PaperControl } from "./paper-runtime.ts";

export { sessionTimes };
type Holding = { contract: OrbCallContract; entryPrice: number; mark: CallQuote | null };
export interface OrbPaperCheckpoint { engine: OrbSnapshot; holdings: Record<string, Holding>; loaded: boolean;
  nextMark: number; committedCents: number; realizedPnlCents: number; complete: boolean; lastQuoteAt: string | null; resumed: boolean;
  protectiveExits: Record<string, PersistentExit> }
/** Sell-everything exits that keep retrying on later ticks (through rebounds and restarts) until a fresh bid fills them. */
const PERSISTENT_EXITS = ["protective_stop", "breakeven_stop", "broker_backstop", "session_close"] as const satisfies readonly SaleReason[];
type PersistentExit = typeof PERSISTENT_EXITS[number];
const isPersistentExit = (reason: unknown): reason is PersistentExit => (PERSISTENT_EXITS as readonly unknown[]).includes(reason);
export class OrbPaperRuntime implements PaperRuntime {
  #config: OrbOptionsConfig; #market: PaperMarket; #clock: () => number; #engine: OrbOptionsEngine;
  #saved: Omit<OrbPaperCheckpoint, "engine">; #session: { open: number; close: number }; #resumeNotes: string[] = [];
  /** When each kind of read began failing, for the current outage only (a restart starts clean). */
  #gaps: Partial<Record<"quotes" | "bars" | "options", number>> = {};
  constructor(raw: unknown, market: PaperMarket, clock = Date.now, checkpoint?: unknown) {
    this.#config = parseOrbOptionsConfig(raw); this.#market = market; this.#clock = clock;
    this.#engine = new OrbOptionsEngine(this.#config); this.#session = sessionTimes(this.#config.date);
    this.#saved = { holdings: {}, loaded: false, nextMark: 0,
      committedCents: 0, realizedPnlCents: 0, complete: false, lastQuoteAt: null, resumed: false, protectiveExits: {} };
    if (checkpoint) {
      const s = checkpoint as OrbPaperCheckpoint;
      if (!s.holdings || !s.protectiveExits || Object.entries(s.protectiveExits).some(([symbol, reason]) =>
        !this.#config.symbols.includes(symbol) || !isPersistentExit(reason)) ||
        !Number.isSafeInteger(s.committedCents) || s.committedCents < 0 || s.committedCents > this.#config.budgetCentsPerDay ||
        !Number.isSafeInteger(s.realizedPnlCents)) throw new Error("Invalid paper checkpoint");
      this.#engine.restore(s.engine);
      for (const [symbol, state] of Object.entries(s.engine.symbols)) if (state.position) {
        const h = s.holdings[symbol];
        if (!h || h.contract.id !== state.position.contractId || !(h.entryPrice > 0) || h.contract.symbol !== symbol ||
          h.entryPrice !== state.position.entryPremium) throw new Error("Saved contract mismatch");
      }
      const { engine: _, ...rest } = structuredClone(s); this.#saved = { ...rest, resumed: true, complete: false };
      // A gap may hide a low breach. Recovery manages existing positions only.
      for (const h of Object.values(this.#saved.holdings)) h.mark = null;
      // Recovery manages prior positions only, so symbols still watching (or awaiting a range) are done for the day, and say so.
      for (const [symbol, state] of Object.entries(this.#engine.snapshot().symbols))
        if ((state.status === "watching" || state.status === "forming") && clock() < this.#session.close) {
          this.#engine.disqualify(symbol, "resumed_management_only"); this.#resumeNotes.push(symbol);
        }
    }
  }
  checkpoint(): OrbPaperCheckpoint { return { ...structuredClone(this.#saved), engine: this.#engine.snapshot() }; }
  #validOption(q: CallQuote | undefined): q is CallQuote {
    if (!q || !(q.bid > 0 && q.ask >= q.bid && Number.isFinite(q.ask))) return false;
    return [q.updatedAt, q.retrievedAt].every(t => { const age = this.#clock() - Date.parse(t); return Number.isFinite(age) && age >= 0 && age <= this.#config.maxQuoteAgeMs; });
  }
  /** An active regular-session trade no older than maxQuoteAgeMs when it was fetched, and never after its own fetch
   *  (clock skew between the venue and this machine must not become an impossible observation). */
  #fresh(q: Awaited<ReturnType<PaperMarket["quotes"]>>[number] | undefined): boolean {
    if (!q || !q.regularSession || q.state !== "active" || !(Number.isFinite(q.price) && q.price! > 0) || !q.tradeAt) return false;
    const retrieved = Date.parse(q.retrievedAt), age = retrieved - Date.parse(q.tradeAt);
    return Number.isFinite(age) && age >= 0 && age <= this.#config.maxQuoteAgeMs && retrieved <= this.#clock();
  }
  async #handle(intent: OrbIntent, fetched?: CallQuote): Promise<PaperEvent[]> {
    if (intent.kind === "enter_calls") {
      try {
        if (this.#clock() >= this.#session.close - this.#config.flattenLeadMinutes * 60000) throw new EntrySkip("too_close_to_session_end");
        const catalog = await this.#market.calls(intent.symbol, this.#config.date);
        const stock = (await this.#market.quotes([intent.symbol]))[0];
        if (stock?.symbol !== intent.symbol || !this.#fresh(stock)) throw new Error("Stale breakout quote");
        if (stock!.price! <= intent.range.high) throw new EntrySkip("breakout_reversed");
        // Committed premium never decreases (proceeds never replenish the budget), so the day cap is spent, not recycled.
        const capCents = Math.min(this.#config.budgetCentsPerPosition, this.#config.budgetCentsPerDay - this.#saved.committedCents);
        const selected = selectOrbCall(catalog.contracts, catalog.quotes, intent.symbol, catalog.expiration, stock!.price!, this.#config, this.#clock(), capCents);
        // capCents already bounds the selection; the day-cap comparison is a defensive restatement of the invariant.
        if (!selected || this.#saved.committedCents + selected.committedCents > this.#config.budgetCentsPerDay) throw new EntrySkip("no_affordable_eligible_call");
        const backstop = backstopPrice(selected.limitPrice, selected.contract, this.#config.backstopFraction);
        this.#engine.confirmEntry(intent.symbol, selected.contract.id, selected.quantity, stock!.price!, selected.limitPrice, backstop);
        this.#saved.holdings[intent.symbol] = { contract: selected.contract, entryPrice: selected.limitPrice, mark: null };
        this.#saved.committedCents += selected.committedCents;
        return [{ type: "option_selection", data: { symbol: intent.symbol, contracts: catalog.contracts, quotes: catalog.quotes, selected, stock } },
          { type: "paper_entry", data: { symbol: intent.symbol, setup: intent.setup, stockPrice: stock!.price,
          strike: selected.contract.strike, expiration: selected.contract.expiration, quantity: selected.quantity,
          assumedFill: selected.limitPrice, committedCents: selected.committedCents, backstopPrice: backstop, fillGuaranteed: false } }];
      } catch (error) {
        // Rule decisions and calendar gaps are named, so a review can tell a policy skip from a data problem.
        const reason = error instanceof EntrySkip ? error.reason : error instanceof CalendarCoverageError ? "calendar_not_covered" : "data_unavailable";
        const detail = reason === "data_unavailable" ? { detail: String((error as Error)?.message ?? error).slice(0, 200) } : {};
        this.#engine.failEntry(intent.symbol); return [{ type: "entry_skipped", data: { symbol: intent.symbol, reason, ...detail } }];
      }
    }
    if (isPersistentExit(intent.reason)) this.#saved.protectiveExits[intent.symbol] = intent.reason;
    try {
      const quote = fetched ?? (await this.#market.optionQuotes([intent.contractId])).find(q => q.id === intent.contractId);
      if (!this.#validOption(quote)) throw new Error("Stale option bid");
      const h = this.#saved.holdings[intent.symbol]!;
      const pnlCents = Math.round((quote.bid - h.entryPrice) * 10000 * intent.quantity);
      this.#engine.confirmSale(intent.symbol, intent.quantity); h.mark = quote; this.#saved.realizedPnlCents += pnlCents;
      if (this.#engine.snapshot().symbols[intent.symbol]!.status === "closed") delete this.#saved.protectiveExits[intent.symbol];
      return [{ type: "paper_sale", data: { symbol: intent.symbol, quantity: intent.quantity, reason: intent.reason,
        stockPrice: intent.stockPrice, quote, assumedFill: quote.bid, realizedPnlCents: pnlCents, fillGuaranteed: false, feesExcluded: true,
        ...(intent.targets ? { targets: intent.targets } : {}) } }];
    } catch { this.#engine.failSale(intent.symbol); return [{ type: "sale_deferred", data: { symbol: intent.symbol, reason: "fresh_option_bid_unavailable" } }]; }
  }
  /** Ticks at this interval; the controller's timer honors it. */
  get pollMs() { return this.#config.pollMs; }
  async step(): Promise<PaperEvent[]> {
    const events: PaperEvent[] = [];
    // A failed step still reports what it did first, so a halt record never hides a confirmed entry or sale.
    try { await this.#step(events); } catch (error) { throw new StepError(error, events); }
    return events;
  }
  async #step(events: PaperEvent[]): Promise<void> {
    const now = this.#clock(), { open, close } = this.#session, c = this.#config;
    if (this.#saved.complete || now < open + 120000) return;
    for (const symbol of this.#resumeNotes.splice(0)) events.push({ type: "setup_disqualified", data: { symbol, reason: "resumed_management_only" } });
    if (now >= close) {
      for (const symbol of this.#engine.closeEntryWindow(now)) events.push({ type: "setup_disqualified", data: { symbol, reason: "entry_window_closed" } });
      // Money lost: contracts still unsold at the close are written off at -100% of their remaining premium.
      for (const p of this.view().positions) {
        const quantity = this.#engine.writeOff(p.symbol); if (!quantity) continue;
        const lossCents = -Math.round(p.entryPrice * 10000 * quantity); this.#saved.realizedPnlCents += lossCents; delete this.#saved.protectiveExits[p.symbol];
        events.push({ type: "written_off", data: { symbol: p.symbol, contractId: p.contractId, quantity, realizedPnlCents: lossCents, reason: "unsold_at_session_end" } });
      }
      this.#saved.complete = true;
      events.push({ type: "session_ended", data: { writtenOff: events.filter(e => e.type === "written_off").length, noAutomaticCarryOrExercise: true } });
      return;
    }
    await this.#loadRanges(now, events);
    for (const symbol of this.#engine.closeEntryWindow(now)) events.push({ type: "setup_disqualified", data: { symbol, reason: "entry_window_closed" } });
    const quotes = await this.#read("quotes", now, events, async () => {
      const batch = await this.#market.quotes(c.symbols);
      if (batch.length !== c.symbols.length || new Set(batch.map(q => q.symbol)).size !== batch.length || batch.some(q => !c.symbols.includes(q.symbol)))
        throw new Error("Incomplete or mismatched quote batch");
      return batch;
    });
    for (const q of (quotes ?? []).sort((a, b) => (a.tradeAt ?? "").localeCompare(b.tradeAt ?? "") || a.symbol.localeCompare(b.symbol))) {
      events.push({ type: "quote", data: q });
      if (!this.#fresh(q)) continue;
      this.#saved.lastQuoteAt = q.tradeAt;
      const state = this.#engine.snapshot().symbols[q.symbol]!, observedAt = Date.parse(q.retrievedAt);
      // Never infer an unobserved path: a stock first seen after the opening window cannot use its opening range.
      if (state.lastObservationMs === null && observedAt > open + 120000 + c.maxObservationGapMs) this.#engine.disqualify(q.symbol, "late_first_quote");
      if (this.#saved.resumed && state.status !== "open") continue;
      // Observed as of retrieval, so time spent handling other stocks is not a market gap. Stocks whose range bars are
      // still pending are observed too: the engine keeps their lowest trade and any gap for when the range arrives.
      for (const intent of this.#engine.observe(q.symbol, q.price!, Date.parse(q.tradeAt!), observedAt)) events.push(...await this.#handle(intent));
      // Journal the rule that ended watching (opening low, gap, late first quote) with the observation behind it.
      const after = this.#engine.snapshot().symbols[q.symbol]!;
      if ((state.status === "watching" || state.status === "forming") && after.status === "disqualified")
        events.push({ type: "setup_disqualified", data: { symbol: q.symbol, reason: after.endReason, price: q.price, tradeAt: q.tradeAt } });
    }
    // Option-price decisions need only a fresh option bid, one batch per tick: targets, the simulated Robinhood backstop,
    // pending sell-everything exits and the final-minute flatten. A missing bid never fabricates a fill.
    const held = this.view().positions;
    if (held.length) {
      const batch = await this.#read("options", now, events, () => this.#market.optionQuotes(held.map(p => p.contractId))) ?? [];
      for (const p of held) {
        const quote = batch.find(q => q.id === p.contractId), valid = this.#validOption(quote);
        this.#saved.holdings[p.symbol]!.mark = valid ? quote! : null;
        if (!valid || this.#engine.snapshot().symbols[p.symbol]!.status !== "open") continue;
        const pending = this.#saved.protectiveExits[p.symbol], at = Date.parse(quote!.updatedAt);
        const intents = pending || now >= close - c.flattenLeadMinutes * 60000
          ? this.#engine.requestPositionSale(p.symbol, pending ?? "session_close", p.quantity, p.quantity, null, at)
          : this.#engine.observeOption(p.symbol, quote!.bid, at);
        for (const intent of intents) events.push(...await this.#handle(intent, quote));
      }
      if (now >= this.#saved.nextMark) {
        for (const p of held) events.push({ type: "option_mark", data: { symbol: p.symbol, quote: this.#saved.holdings[p.symbol]!.mark } });
        this.#saved.nextMark = now + 5000;
      }
    }
    const holding = this.view().positions.length > 0;
    if (!holding) delete this.#gaps.options;   // nothing held: an option outage no longer matters
    // Halt only after data has been out longer than the setting. With positions open, bid-driven exits keep managing them
    // through an equity outage (a halt would end in a -100% settlement), so the run halts only if option prices are out too.
    const outFor = (source: "quotes" | "options") => this.#gaps[source] === undefined ? 0 : now - this.#gaps[source]!;
    if (outFor("quotes") > c.readFailureHaltMs && (!holding || outFor("options") > c.readFailureHaltMs))
      throw new Error(`Market data unavailable for more than ${c.readFailureHaltMs / 1000} s`);
  }
  /** Opening ranges from minute bars, retried each tick until rangeDeadlineMs after the first candle: its last bar can
   *  publish late, and stocks keep being observed meanwhile. */
  async #loadRanges(now: number, events: PaperEvent[]): Promise<void> {
    const { open } = this.#session, c = this.#config, symbols = this.#engine.snapshot().symbols;
    const forming = c.symbols.filter(s => symbols[s]!.status === "forming");
    if (!this.#saved.loaded) {
      this.#saved.loaded = true;
      // A run first ticking after the opening window has an unobserved path, so its ranges cannot be used today.
      if (now > open + 120000 + c.maxObservationGapMs) {
        for (const symbol of forming) { this.#engine.failRange(symbol, "late_first_quote"); events.push({ type: "setup_disqualified", data: { symbol, reason: "late_first_quote" } }); }
        return;
      }
    }
    if (!forming.length) { delete this.#gaps.bars; return; }
    if (now > open + 120000 + c.rangeDeadlineMs) {
      for (const symbol of forming) { this.#engine.failRange(symbol, "range_unavailable"); events.push({ type: "setup_disqualified", data: { symbol, reason: "range_unavailable" } }); }
      return;
    }
    const bars = await this.#read("bars", now, events,
      () => this.#market.bars(forming, open - c.includePremarketLeadMinutes * 60000, open + 120000, c.includePremarketLeadMinutes > 0));
    if (bars === null) return;
    for (const symbol of forming) {
      let range: OpeningRange;
      try { range = parseOpeningRange(bars, symbol, open, 2, c.includePremarketLeadMinutes); } catch { continue; }   // not published yet: retry
      const lowSeen = symbols[symbol]!.lowAfterRangeEnd;
      this.#engine.setRange(symbol, range); events.push({ type: "opening_range", data: { symbol, range } });
      const after = this.#engine.snapshot().symbols[symbol]!;
      if (after.status === "disqualified") events.push({ type: "setup_disqualified", data: { symbol, reason: after.endReason, lowSeen } });
    }
  }
  /** One provider read. A failure never ends the step: it is journaled once per outage (data_gap), recovery too, and yields null. */
  async #read<T>(source: "quotes" | "bars" | "options", now: number, events: PaperEvent[], read: () => Promise<T>): Promise<T | null> {
    try {
      const value = await read(), since = this.#gaps[source];
      if (since !== undefined) { delete this.#gaps[source]; events.push({ type: "data_restored", data: { source, outageMs: now - since } }); }
      return value;
    } catch (error) {
      if (this.#gaps[source] === undefined) {
        this.#gaps[source] = now;
        events.push({ type: "data_gap", data: { source, detail: String((error as Error)?.message ?? error).slice(0, 200) } });
      }
      return null;
    }
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
        markBid: mark?.bid ?? null, markAt: mark?.updatedAt ?? null, stage: p.stage, backstop: p.backstopPrice,
        stop: p.stage === "breakeven" ? p.entryStockPrice : state.range!.low * (1 - this.#config.stopBufferFraction) });
    }
    return { positions, committedCents: this.#saved.committedCents, realizedPnlCents: this.#saved.realizedPnlCents,
      unrealizedPnlCents: positions.some(p => p.markBid === null) ? null : positions.reduce((sum, p) => sum + Math.round((p.markBid! - p.entryPrice) * 10000 * p.quantity), 0),
      lastQuoteAt: this.#saved.lastQuoteAt, complete: this.#saved.complete, dataGapSince: this.#dataGapSince(), detail: snapshot };
  }
  #dataGapSince(): string | null {
    const since = Math.min(...Object.values(this.#gaps) as number[]);
    return Number.isFinite(since) ? new Date(since).toISOString() : null;
  }
}
