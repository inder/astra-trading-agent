import { EntrySkip, OrbOptionsEngine, backstopPrice, parseOrbOptionsConfig, parseOpeningRange, selectOrbCall, strikeBatches, type OpeningRange,
  type OrbOptionsConfig, type OrbSnapshot, type OrbIntent, type CallQuote, type OrbCallContract, type OrbCallSelection, type SaleReason } from "./orb-options.ts";
import { CalendarCoverageError, sessionTimes } from "./daily-history.ts";
import type { OptionCatalog, PaperMarket } from "./paper-market.ts";
import { StepError, type PaperRuntime, type PaperEvent, type PaperPosition, type PaperControl } from "./paper-runtime.ts";

export { sessionTimes };
type Holding = { contract: OrbCallContract; entryPrice: number; mark: CallQuote | null };
export interface OrbPaperCheckpoint { engine: OrbSnapshot; holdings: Record<string, Holding>; loaded: boolean;
  nextHeartbeat: number; committedCents: number; realizedPnlCents: number; complete: boolean; lastQuoteAt: string | null; resumed: boolean;
  protectiveExits: Record<string, PersistentExit> }
/** Sell-everything exits that keep retrying on later ticks (through rebounds and restarts) until a fresh bid fills them. */
const PERSISTENT_EXITS = ["protective_stop", "breakeven_stop", "broker_backstop", "session_close"] as const satisfies readonly SaleReason[];
type PersistentExit = typeof PERSISTENT_EXITS[number];
const isPersistentExit = (reason: unknown): reason is PersistentExit => (PERSISTENT_EXITS as readonly unknown[]).includes(reason);
type Source = "quotes" | "bars" | "options" | "catalog";
/** A stock's catalog, or the rule decision that it has nothing to trade today (a decision, never an outage). */
type Catalog = OptionCatalog | { skip: string };
const iso = (ms: number) => new Date(ms).toISOString();
export class OrbPaperRuntime implements PaperRuntime {
  #config: OrbOptionsConfig; #market: PaperMarket; #clock: () => number; #engine: OrbOptionsEngine;
  #saved: Omit<OrbPaperCheckpoint, "engine">; #session: { open: number; close: number }; #resumeNotes: string[] = [];
  /** When each kind of read began failing, for the current outage only (a restart starts clean). */
  #gaps: Partial<Record<Source, number>> = {};
  /** Outages already journaled: a single failed read is only counted, in the heartbeat. */
  #journaledGaps = new Set<Source>();
  #failures: Partial<Record<Source, number>> = {};
  /** Session catalogs, prefetched before 9:32. Memory only: a restarted run manages positions and never enters. */
  #catalogs = new Map<string, Catalog>(); #slowestCatalogMs = 0; #prefetches = 0; #prefetchOver = false;
  /** Journaled once per outage or per trigger, keyed "symbol:exit": the "no fresh bid" deferral of a sell-everything exit,
   *  and a stop firing while a different exit is already pending. Each re-fires every tick until the position sells. */
  #deferred = new Set<string>(); #triggered = new Set<string>();
  /** Since the last heartbeat: each stock's observed price range and count, and its latest quote. */
  #seen = new Map<string, { low: number; high: number; observations: number }>();
  #latest = new Map<string, { price: number | null; tradeAt: string | null; fresh: boolean }>();
  constructor(raw: unknown, market: PaperMarket, clock = Date.now, checkpoint?: unknown) {
    this.#config = parseOrbOptionsConfig(raw); this.#market = market; this.#clock = clock;
    this.#engine = new OrbOptionsEngine(this.#config); this.#session = sessionTimes(this.#config.date);
    this.#saved = { holdings: {}, loaded: false, nextHeartbeat: 0,
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
  /** A stock's catalog, or the rule decision that it has nothing to trade (no qualifying expiry, calendar not covered). */
  async #loadCatalog(symbol: string): Promise<Catalog> {
    try { return await this.#market.contracts(symbol, this.#config.date); }
    catch (error) {
      if (error instanceof EntrySkip) return { skip: error.reason };
      if (error instanceof CalendarCoverageError) return { skip: "calendar_not_covered" };
      throw error;
    }
  }
  async #handle(intent: OrbIntent, fetched?: CallQuote): Promise<PaperEvent[]> {
    if (intent.kind === "enter_calls") {
      const c = this.#config; let quotes: CallQuote[] = [], batches = 0;
      try {
        if (this.#clock() >= this.#session.close - c.flattenLeadMinutes * 60000) throw new EntrySkip("too_close_to_session_end");
        // Catalog first (prefetched before 9:32, else loaded now), then the fresh stock quote, then the nearest strikes' quotes.
        let catalog = this.#catalogs.get(intent.symbol);
        if (!catalog) { catalog = await this.#counted("catalog", () => this.#loadCatalog(intent.symbol)); this.#catalogs.set(intent.symbol, catalog); }
        if ("skip" in catalog) throw new EntrySkip(catalog.skip);
        const stock = (await this.#counted("quotes", () => this.#market.quotes([intent.symbol])))[0];
        if (stock?.symbol !== intent.symbol || !this.#fresh(stock)) throw new Error("Stale breakout quote");
        if (stock!.price! <= intent.range.high) throw new EntrySkip("breakout_reversed", { price: stock!.price, tradeAt: stock!.tradeAt });
        // Committed premium never decreases (proceeds never replenish the budget), so the day cap is spent, not recycled.
        const capCents = Math.min(c.budgetCentsPerPosition, c.budgetCentsPerDay - this.#saved.committedCents);
        // Nearest strikes first, a batch at a time: the first batch holding any qualifying strike holds the nearest one.
        const plan = strikeBatches(catalog.contracts, stock!.price!);
        let selected: OrbCallSelection | null = null;
        for (const batch of plan.slice(0, c.maxEntryQuoteBatches)) {
          batches++; quotes = [...quotes, ...await this.#counted("options", () => this.#market.optionQuotes(batch.map(k => k.id)))];
          selected = selectOrbCall(catalog.contracts, quotes, intent.symbol, catalog.expiration, stock!.price!, c, this.#clock(), capCents);
          if (selected) break;
        }
        // capCents already bounds the selection; the day-cap comparison is a defensive restatement of the invariant.
        if (!selected || this.#saved.committedCents + selected.committedCents > c.budgetCentsPerDay)
          throw new EntrySkip(plan.length > c.maxEntryQuoteBatches ? "no_qualifying_call_within_quote_batches" : "no_affordable_eligible_call",
            { quotedContracts: quotes.length, batches });
        const backstop = backstopPrice(selected.limitPrice, selected.contract, c.backstopFraction);
        this.#engine.confirmEntry(intent.symbol, selected.contract.id, selected.quantity, stock!.price!, selected.limitPrice, backstop);
        this.#saved.holdings[intent.symbol] = { contract: selected.contract, entryPrice: selected.limitPrice, mark: null };
        this.#saved.committedCents += selected.committedCents;
        const quoted = new Set(quotes.map(q => q.id));
        return [{ type: "option_selection", data: { symbol: intent.symbol, batches, contracts: catalog.contracts.filter(k => quoted.has(k.id)), quotes, selected, stock } },
          { type: "paper_entry", data: { symbol: intent.symbol, setup: intent.setup, stockPrice: stock!.price,
          strike: selected.contract.strike, expiration: selected.contract.expiration, quantity: selected.quantity,
          assumedFill: selected.limitPrice, committedCents: selected.committedCents, backstopPrice: backstop, fillGuaranteed: false } }];
      } catch (error) {
        // Rule decisions and calendar gaps are named, so a review can tell a policy skip from a data problem.
        const reason = error instanceof EntrySkip ? error.reason : error instanceof CalendarCoverageError ? "calendar_not_covered" : "data_unavailable";
        const evidence = error instanceof EntrySkip ? error.evidence : reason === "data_unavailable" ? { detail: String((error as Error)?.message ?? error).slice(0, 200) } : {};
        this.#engine.failEntry(intent.symbol); return [{ type: "entry_skipped", data: { symbol: intent.symbol, reason, ...evidence } }];
      }
    }
    // A stock-triggered sell-everything exit is executed by this tick's option batch: one quote request per tick however many
    // stops fire. The stop re-fires every tick until it fills, so each trigger is journaled once, with its observation. The
    // first pending exit is the one executed; a different one firing meanwhile is journaled as such.
    if (!fetched && isPersistentExit(intent.reason)) {
      this.#engine.failSale(intent.symbol);
      const pending = this.#saved.protectiveExits[intent.symbol], trigger = { symbol: intent.symbol, exit: intent.reason, stockPrice: intent.stockPrice, tradeAt: iso(intent.at) };
      if (pending === intent.reason) return [];
      if (pending) {
        const key = `${intent.symbol}:${intent.reason}`; if (this.#triggered.has(key)) return [];
        this.#triggered.add(key); return [{ type: "exit_triggered", data: { ...trigger, alreadyPending: pending } }];
      }
      this.#saved.protectiveExits[intent.symbol] = intent.reason;
      return [{ type: "exit_triggered", data: trigger }];
    }
    if (isPersistentExit(intent.reason)) this.#saved.protectiveExits[intent.symbol] = intent.reason;
    try {
      const quote = fetched ?? (await this.#counted("options", () => this.#market.optionQuotes([intent.contractId]))).find(q => q.id === intent.contractId);
      if (!this.#validOption(quote)) throw new Error("Stale option bid");
      const h = this.#saved.holdings[intent.symbol]!;
      const pnlCents = Math.round((quote.bid - h.entryPrice) * 10000 * intent.quantity);
      this.#engine.confirmSale(intent.symbol, intent.quantity); h.mark = quote; this.#saved.realizedPnlCents += pnlCents;
      this.#forget(intent.symbol);
      if (this.#engine.snapshot().symbols[intent.symbol]!.status === "closed") delete this.#saved.protectiveExits[intent.symbol];
      return [{ type: "paper_sale", data: { symbol: intent.symbol, quantity: intent.quantity, reason: intent.reason,
        stockPrice: intent.stockPrice, triggeredAt: iso(intent.at), quote, assumedFill: quote.bid, realizedPnlCents: pnlCents,
        fillGuaranteed: false, feesExcluded: true, ...(intent.targets ? { targets: intent.targets } : {}) } }];
    } catch {
      this.#engine.failSale(intent.symbol);
      return isPersistentExit(intent.reason) ? this.#deferOnce(intent.symbol, intent.reason, intent.stockPrice, intent.at)
        : [{ type: "sale_deferred", data: { symbol: intent.symbol, reason: "fresh_option_bid_unavailable", exit: intent.reason, stockPrice: intent.stockPrice, at: iso(intent.at) } }];
    }
  }
  /** A read outside the tick's own (an entry's quotes and catalog, a user sale's bid): its failure still counts in the heartbeat. */
  async #counted<T>(source: Source, read: () => Promise<T>): Promise<T> {
    try { return await read(); } catch (error) { this.#failures[source] = (this.#failures[source] ?? 0) + 1; throw error; }
  }
  /** A position that sold or was written off no longer has deferrals or triggers to journal. */
  #forget(symbol: string): void {
    for (const set of [this.#deferred, this.#triggered]) for (const key of [...set]) if (key.startsWith(symbol + ":")) set.delete(key);
  }
  /** "No fresh bid" for a due sell-everything exit is journaled once per outage; the exit keeps retrying every tick. */
  #deferOnce(symbol: string, exit: string, stockPrice: number | null, at: number): PaperEvent[] {
    const key = `${symbol}:${exit}`; if (this.#deferred.has(key)) return [];
    this.#deferred.add(key);
    return [{ type: "sale_deferred", data: { symbol, reason: "fresh_option_bid_unavailable", exit, stockPrice, at: iso(at) } }];
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
    const now = this.#clock(), { close } = this.#session, c = this.#config, rangeEnd = this.#engine.rangeEndMs;
    if (this.#saved.complete) return;
    if (now < rangeEnd) { if (!this.#saved.resumed) await this.#prefetch(now, rangeEnd, events); return; }
    if (!this.#prefetchOver) { this.#prefetchOver = true; this.#endGap("catalog", now, events, "prefetch_window_closed"); }
    for (const symbol of this.#resumeNotes.splice(0)) events.push({ type: "setup_disqualified", data: { symbol, reason: "resumed_management_only" } });
    if (now >= close) {
      for (const symbol of this.#engine.closeEntryWindow(now)) events.push({ type: "setup_disqualified", data: { symbol, reason: "entry_window_closed" } });
      // Money lost: contracts still unsold at the close are written off at -100% of their remaining premium.
      for (const p of this.view().positions) {
        const quantity = this.#engine.writeOff(p.symbol); if (!quantity) continue;
        const lossCents = -Math.round(p.entryPrice * 10000 * quantity); this.#saved.realizedPnlCents += lossCents; delete this.#saved.protectiveExits[p.symbol];
        this.#forget(p.symbol);
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
    // Quotes are not journaled one by one: decisions carry the observation behind them and the heartbeat summarizes the rest.
    for (const q of (quotes ?? []).sort((a, b) => (a.tradeAt ?? "").localeCompare(b.tradeAt ?? "") || a.symbol.localeCompare(b.symbol))) {
      const fresh = this.#fresh(q);
      this.#latest.set(q.symbol, { price: q.price, tradeAt: q.tradeAt, fresh });
      if (!fresh) continue;
      this.#saved.lastQuoteAt = q.tradeAt;
      const seen = this.#seen.get(q.symbol);
      this.#seen.set(q.symbol, seen ? { low: Math.min(seen.low, q.price!), high: Math.max(seen.high, q.price!), observations: seen.observations + 1 }
        : { low: q.price!, high: q.price!, observations: 1 });
      const state = this.#engine.snapshot().symbols[q.symbol]!, observedAt = Date.parse(q.retrievedAt);
      // Never infer an unobserved path: a stock first seen after the opening window cannot use its opening range.
      if (state.lastObservationMs === null && observedAt > rangeEnd + c.maxObservationGapMs) this.#engine.disqualify(q.symbol, "late_first_quote");
      if (this.#saved.resumed && state.status !== "open") continue;
      // Observed as of retrieval, so time spent handling other stocks is not a market gap. Stocks whose range bars are
      // still pending are observed too: the engine keeps their lowest trade and any gap for when the range arrives.
      const intents = this.#engine.observe(q.symbol, q.price!, Date.parse(q.tradeAt!), observedAt);
      for (const intent of intents) events.push(...await this.#handle(intent));
      // Journal the rule that ended watching (opening low, gap, late first quote) with the observation behind it; a gap
      // also names its other end, which the engine no longer holds after this tick.
      const after = this.#engine.snapshot().symbols[q.symbol]!;
      if ((state.status === "watching" || state.status === "forming") && after.status === "disqualified")
        events.push({ type: "setup_disqualified", data: { symbol: q.symbol, reason: after.endReason, price: q.price, tradeAt: q.tradeAt,
          ...(after.endReason === "observation_gap" && state.lastObservationMs !== null && state.lastTradeMs !== null
            ? { previousObservedAt: iso(state.lastObservationMs), previousTradeAt: iso(state.lastTradeMs) } : {}) } });
      // A breakout with every position slot taken is a skip too, and says so.
      if (state.status === "watching" && after.status === "skipped" && !intents.length)
        events.push({ type: "entry_skipped", data: { symbol: q.symbol, reason: "maximum_positions_reached", price: q.price, tradeAt: q.tradeAt } });
    }
    // Option-price decisions need only a fresh option bid, one batch per tick: targets, the simulated Robinhood backstop,
    // pending sell-everything exits (including stock-triggered stops) and the final-minute flatten. No bid is ever invented.
    const held = this.view().positions;
    if (held.length) {
      const batch = await this.#read("options", now, events, () => this.#market.optionQuotes(held.map(p => p.contractId))) ?? [];
      for (const p of held) {
        const quote = batch.find(q => q.id === p.contractId), valid = this.#validOption(quote);
        this.#saved.holdings[p.symbol]!.mark = valid ? quote! : null;
        const state = this.#engine.snapshot().symbols[p.symbol]!;
        if (state.status !== "open") continue;
        const pending = this.#saved.protectiveExits[p.symbol], closing = now >= close - c.flattenLeadMinutes * 60000;
        if (!valid) { if (pending || closing) events.push(...this.#deferOnce(p.symbol, pending ?? "session_close", state.lastPrice, now)); continue; }
        const at = Date.parse(quote!.updatedAt);
        const intents = pending || closing
          ? this.#engine.requestPositionSale(p.symbol, pending ?? "session_close", p.quantity, p.quantity, null, at)
          : this.#engine.observeOption(p.symbol, quote!.bid, at);
        for (const intent of intents) events.push(...await this.#handle(intent, quote));
      }
    }
    const holding = this.view().positions.length > 0;
    if (!holding) this.#endGap("options", now, events, "nothing_held");   // an option outage no longer matters
    if (now >= this.#saved.nextHeartbeat) {
      events.push({ type: "heartbeat", data: { latest: Object.fromEntries(this.#latest), observed: Object.fromEntries(this.#seen),
        marks: Object.fromEntries(this.view().positions.map(p => [p.symbol, { bid: p.markBid, at: p.markAt }])),
        readFailures: this.#failures, dataGapSince: this.#dataGapSince() } });
      this.#saved.nextHeartbeat = now + c.heartbeatMs; this.#seen.clear(); this.#failures = {};
    }
    // Halt only after data has been out longer than the setting. With positions open, bid-driven exits keep managing them
    // through an equity outage (a halt would end in a -100% settlement), so the run halts only if option prices are out too.
    const outFor = (source: Source) => this.#gaps[source] === undefined ? 0 : now - this.#gaps[source]!;
    if (outFor("quotes") > c.readFailureHaltMs && (!holding || outFor("options") > c.readFailureHaltMs))
      throw new Error(`Market data unavailable for more than ${c.readFailureHaltMs / 1000} s`);
  }
  /** Before 9:32, load one stock's catalog per tick, rotating past failures. A load must never run into the first observation
   *  after the range end (the late-first-quote rule would cost every stock its day): one starts only when more time is left
   *  than the slowest load seen, and it is abandoned, like a failed read, at the range end minus one poll. Anything not
   *  loaded by then loads at its entry. */
  async #prefetch(now: number, rangeEnd: number, events: PaperEvent[]): Promise<void> {
    const missing = this.#config.symbols.filter(s => !this.#catalogs.has(s)), budgetMs = rangeEnd - this.#config.pollMs - now;
    if (!missing.length || budgetMs <= this.#slowestCatalogMs) return;
    const symbol = missing[this.#prefetches++ % missing.length]!, started = this.#clock();
    const catalog = await this.#read("catalog", now, events, () => this.#withDeadline(symbol, budgetMs));
    this.#slowestCatalogMs = Math.max(this.#slowestCatalogMs, this.#clock() - started);
    if (!catalog) return;
    this.#catalogs.set(symbol, catalog);
    if ("skip" in catalog) events.push({ type: "no_tradable_calls", data: { symbol, reason: catalog.skip } });
  }
  /** A catalog load raced against a real-time deadline. The provider call cannot be cancelled; if it finishes late its catalog
   *  is still kept for the entry (no event is written outside a step). */
  #withDeadline(symbol: string, ms: number): Promise<Catalog> {
    const load = this.#loadCatalog(symbol);
    load.then(catalog => { if (!this.#catalogs.has(symbol)) this.#catalogs.set(symbol, catalog); }, () => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Catalog load ran past the prefetch deadline")), ms); timer.unref?.();
    });
    return Promise.race([load, deadline]).finally(() => clearTimeout(timer));
  }
  /** Opening ranges from minute bars, retried each tick until rangeDeadlineMs after the first candle: its last bar can
   *  publish late, and stocks keep being observed meanwhile. */
  async #loadRanges(now: number, events: PaperEvent[]): Promise<void> {
    const { open } = this.#session, c = this.#config, symbols = this.#engine.snapshot().symbols, rangeEnd = this.#engine.rangeEndMs;
    const forming = c.symbols.filter(s => symbols[s]!.status === "forming");
    if (!this.#saved.loaded) {
      this.#saved.loaded = true;
      // A run first ticking after the opening window has an unobserved path, so its ranges cannot be used today.
      if (now > rangeEnd + c.maxObservationGapMs) {
        for (const symbol of forming) { this.#engine.failRange(symbol, "late_first_quote"); events.push({ type: "setup_disqualified", data: { symbol, reason: "late_first_quote" } }); }
        return;
      }
    }
    if (!forming.length) { this.#endGap("bars", now, events, "no_range_pending"); return; }
    if (now > rangeEnd + c.rangeDeadlineMs) {
      for (const symbol of forming) { this.#engine.failRange(symbol, "range_unavailable"); events.push({ type: "setup_disqualified", data: { symbol, reason: "range_unavailable" } }); }
      return;
    }
    const bars = await this.#read("bars", now, events,
      () => this.#market.bars(forming, open - c.includePremarketLeadMinutes * 60000, rangeEnd, c.includePremarketLeadMinutes > 0));
    if (bars === null) return;
    for (const symbol of forming) {
      let range: OpeningRange;
      try { range = parseOpeningRange(bars, symbol, open, c.openingRangeMinutes, c.includePremarketLeadMinutes); } catch { continue; }   // not published yet: retry
      const lowSeen = symbols[symbol]!.lowAfterRangeEnd;
      this.#engine.setRange(symbol, range); events.push({ type: "opening_range", data: { symbol, range } });
      const after = this.#engine.snapshot().symbols[symbol]!;
      if (after.status === "disqualified") events.push({ type: "setup_disqualified", data: { symbol, reason: after.endReason, lowSeen } });
    }
  }
  /** One provider read. A failure never ends the step. One failed read is only counted (in the heartbeat); a second in a
   *  row opens a journaled outage (data_gap), later closed by data_restored. A flapping provider therefore cannot write
   *  a revision per tick.
   *  A code defect (TypeError/ReferenceError) is not an outage: it halts the step with its message instead of hiding for hours.
   *  Provider and network failures never arrive as TypeError: RobinhoodConnection.read rethrows every failure, fetch's
   *  "TypeError: fetch failed" included, as a plain Error. */
  async #read<T>(source: Source, now: number, events: PaperEvent[], read: () => Promise<T>): Promise<T | null> {
    try {
      const value = await read(), since = this.#gaps[source];
      if (since !== undefined) {
        delete this.#gaps[source];
        if (this.#journaledGaps.delete(source)) events.push({ type: "data_restored", data: { source, outageMs: now - since } });
      }
      return value;
    } catch (error) {
      if (error instanceof TypeError || error instanceof ReferenceError) throw error;
      this.#failures[source] = (this.#failures[source] ?? 0) + 1;
      if (this.#gaps[source] === undefined) this.#gaps[source] = now;
      else if (!this.#journaledGaps.has(source)) {
        this.#journaledGaps.add(source);
        events.push({ type: "data_gap", data: { source, since: iso(this.#gaps[source]!), detail: String((error as Error)?.message ?? error).slice(0, 200) } });
      }
      return null;
    }
  }
  /** An outage that stopped mattering (no range pending, nothing held, prefetch over) closes in the journal. */
  #endGap(source: Source, now: number, events: PaperEvent[], reason: string): void {
    const since = this.#gaps[source]; if (since === undefined) return;
    delete this.#gaps[source];
    if (this.#journaledGaps.delete(source)) events.push({ type: "data_gap_ended", data: { source, outageMs: now - since, reason } });
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
