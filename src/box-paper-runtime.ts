// The support-box strategy's watch-only run (v0.1): it finds and journals setups. It holds no positions, takes no budget,
// simulates no fills and submits no orders. Before 9:32 ET it reads each stock's daily history (the runaway verdict) and the
// minute bars its anchored VWAPs need; from 9:32 it polls quotes like the opening-range runtime, builds 2-minute candles from
// observed trades (ADR 0001, 0002) and feeds the incremental box scanner. Every slow read is detached and bounded by a
// deadline, so no read delays the next quote poll (a late poll would make every candle's close unobserved).
import { sessionTimes } from "./daily-history.ts";
import { BoxScanner, NeedsData, anchoredVwaps, prepareDay, vwapBars, type BoxEvent, type BoxRecord, type Candle, type DayHead, type Support, type VwapBar } from "./box-rules.ts";
import { parseBoxConfig, type BoxConfig } from "./box-settings.ts";
import { ReadGaps, freshTrade, validTrade } from "./market-reads.ts";
import { OPENING_RANGE_MINUTES } from "./orb-options.ts";
import { newCandleState, observeCandles, type CandleState } from "./orb-rules.ts";
import type { PaperMarket } from "./paper-market.ts";
import { StepError, type PaperControl, type PaperEvent, type PaperRuntime } from "./paper-runtime.ts";

type Phase = "loading" | "ready" | "unavailable" | "not_runaway";
type Source = "daily" | "bars" | "quotes";
/** Most detached prefetch reads at once. */
const MAX_IN_FLIGHT = 3;
/** Tries at today's minute bars for one candle before its supports use the prior sessions only (journaled). */
const MAX_TODAY_ATTEMPTS = 3;
/** How long a read of today's minute bars may take. It blocks nothing (the candle waits, the quote polls go on), so it is generous. */
const TODAY_READ_DEADLINE_MS = 30_000;
/** Longest pause between attempts to recover today's minute bars once a symbol is degraded. */
const MAX_TODAY_BACKOFF_MS = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const shownSupport = (s: Support) => ({ kind: s.kind, label: s.label, lo: Math.round(s.lo * 1e4) / 1e4, hi: Math.round(s.hi * 1e4) / 1e4 });

interface SymbolState {
  phase: Phase; head: DayHead | null; prior: VwapBar[]; anchorsPending: string[]; anchorsMissing: string[];
  scanner: BoxScanner | null; candles: CandleState; slots: Map<number, { high: number; low: number; trades: number }>; lastTradeCounted: number;
  dailyRetryAt: number; lastUnavailable: { reason: string; evidence: Record<string, unknown> } | null; todayRetryAt: number; todayBackoffMs: number; closing: boolean; queue: Candle[]; today: { fetchedAt: number; bars: VwapBar[] } | null; todayAttempts: number; degraded: boolean;
  /** When the head candle began waiting for today's bars (null: not waiting); and why the VWAP is degraded. */
  waitingSince: number | null; degradedReason: "reads_failed" | "no_read_slot" | null;
  counts: { formed: number; decided: number; voided: number; expired: number; unobserved: number };
}
type Arrival = (events: PaperEvent[]) => void;

export class BoxPaperRuntime implements PaperRuntime {
  #config: BoxConfig; #market: PaperMarket; #clock: () => number; #session: { open: number; close: number }; #grid: number;
  #symbols = new Map<string, SymbolState>(); #reads = new ReadGaps<Source>();
  #inflight = new Set<string>(); #arrived: Arrival[] = []; #rotation = 0; #gateOpened = false; #complete = false; #nextHeartbeat = 0;
  #latest = new Map<string, { price: number | null; tradeAt: string | null; fresh: boolean }>();
  constructor(raw: unknown, market: PaperMarket, clock = Date.now, checkpoint?: unknown) {
    if (checkpoint !== undefined) throw new Error("A support-box run holds no positions and cannot be resumed");
    this.#config = parseBoxConfig(raw); this.#market = market; this.#clock = clock;
    this.#session = sessionTimes(this.#config.date); this.#grid = this.#session.open + OPENING_RANGE_MINUTES * 60000;
    for (const symbol of this.#config.symbols) this.#symbols.set(symbol, { phase: "loading", head: null, prior: [], anchorsPending: [], anchorsMissing: [],
      scanner: null, candles: newCandleState(this.#grid, this.#config.candleMinutes), slots: new Map(), lastTradeCounted: -Infinity, dailyRetryAt: 0, lastUnavailable: null, todayRetryAt: 0, todayBackoffMs: this.#config.maxObservationGapMs, closing: false, queue: [],
      today: null, todayAttempts: 0, degraded: false, waitingSince: null, degradedReason: null, counts: { formed: 0, decided: 0, voided: 0, expired: 0, unobserved: 0 } });
  }
  get pollMs() { return this.#config.pollMs; }
  checkpoint() { return { complete: this.#complete, resumed: false }; }
  async control(_command: PaperControl): Promise<PaperEvent[]> { throw new Error("A support-box run holds no positions"); }
  view() {
    return { positions: [], committedCents: 0, realizedPnlCents: 0, unrealizedPnlCents: 0, lastQuoteAt: [...this.#latest.values()].map(v => v.tradeAt).filter(Boolean).sort().at(-1) ?? null,
      complete: this.#complete, dataGapSince: this.#reads.since(), detail: { mode: "watch_only", ordersSubmitted: 0, positions: 0,
        symbols: Object.fromEntries([...this.#symbols].map(([s, st]) => [s, { phase: st.phase, ...st.counts, queuedCandles: st.queue.length }])) } };
  }
  async step(): Promise<PaperEvent[]> {
    const events: PaperEvent[] = [];
    // A failed step still reports what it did first, so a halt record never hides an event already produced.
    try { await this.#step(events); } catch (error) { throw new StepError(error, events); }
    return events;
  }

  // ---- Detached reads: started in one step, applied (synchronously) in a later one.
  #launch<T>(key: string, deadlineMs: number, run: () => Promise<T>, apply: (r: { ok: true; value: T } | { ok: false; error: unknown }, startedAt: number, events: PaperEvent[]) => void): void {
    this.#inflight.add(key); const startedAt = this.#clock();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Read ran past its deadline")), Math.max(1, deadlineMs)); timer.unref?.(); });
    Promise.race([Promise.resolve().then(run), deadline]).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }))
      .then(r => { clearTimeout(timer); this.#arrived.push(events => { this.#inflight.delete(key); apply(r, startedAt, events); }); });
  }
  #collect(events: PaperEvent[]): void { for (const apply of this.#arrived.splice(0)) apply(events); }

  async #step(events: PaperEvent[]): Promise<void> {
    const now = this.#clock(), c = this.#config;
    this.#collect(events);
    if (this.#complete) return;
    if (now < this.#grid) { this.#prefetch(now, events); return; }
    if (!this.#gateOpened) this.#openGate(events);
    if (now >= this.#session.close) { this.#finish(events); return; }
    const ready = [...this.#symbols].filter(([, st]) => st.phase === "ready").map(([s]) => s);
    if (ready.length) {
      const quotes = await this.#reads.read("quotes", now, events, async () => {
        const batch = await this.#market.quotes(ready);
        if (batch.length !== ready.length || new Set(batch.map(q => q.symbol)).size !== batch.length || batch.some(q => !ready.includes(q.symbol))) throw new Error("Incomplete or mismatched quote batch");
        return batch;
      });
      for (const q of (quotes ?? []).sort((a, b) => (a.tradeAt ?? "").localeCompare(b.tradeAt ?? "") || a.symbol.localeCompare(b.symbol))) this.#observe(q, now, events);
    }
    for (const [symbol, st] of this.#symbols) if (st.phase === "ready") this.#drain(symbol, st, now, events);
    this.#scheduleToday(now);
    if (now >= this.#nextHeartbeat) {
      events.push({ type: "heartbeat", data: { latest: Object.fromEntries(this.#latest), readFailures: this.#reads.takeFailures(), dataGapSince: this.#reads.since(),
        queuedCandles: Object.fromEntries([...this.#symbols].filter(([, st]) => st.queue.length).map(([s, st]) => [s, st.queue.length])) } });
      this.#nextHeartbeat = now + c.heartbeatMs;
    }
  }

  // ---- Before 9:32: the runaway verdict and the prior sessions' minute bars.
  #prefetch(now: number, events: PaperEvent[]): void {
    const budget = this.#grid - this.#config.pollMs - now;
    if (budget <= 0) return;
    const daily = this.#market.dailyBars;
    for (const [symbol, st] of this.#symbols) {
      if (this.#inflight.size >= MAX_IN_FLIGHT) return;
      if (st.phase !== "loading") continue;
      if (st.head === null && !this.#inflight.has(`daily:${symbol}`)) {
        if (now < st.dailyRetryAt) continue;
        if (!daily) { this.#settle(symbol, st, "unavailable", events, { reason: "daily_bars_not_supported" }); continue; }
        this.#launch(`daily:${symbol}`, budget, () => daily.call(this.#market, symbol, this.#session.open - this.#config.historyDays * 86400000, this.#session.open),
          (r, _at, ev) => this.#dailyArrived(symbol, r, ev));
        continue;
      }
      for (const date of st.anchorsPending.filter(d => !this.#inflight.has(`bars:${symbol}:${d}`)).slice(0, MAX_IN_FLIGHT - this.#inflight.size)) {
        const { open, close } = sessionTimes(date);
        this.#launch(`bars:${symbol}:${date}`, budget, () => this.#market.bars([symbol], open, close, false), (r, _at, ev) => this.#anchorArrived(symbol, date, r, ev));
      }
    }
  }
  #dailyArrived(symbol: string, r: { ok: true; value: { bars: import("./levels.ts").DailyBars } } | { ok: false; error: unknown }, events: PaperEvent[]): void {
    const st = this.#symbols.get(symbol)!;
    if (st.phase !== "loading" || st.head !== null) return;   // the gate already settled this symbol
    // A failed or slow read is tried again after a pause while there is time before 9:32; the gate settles whatever is still unread.
    if (!r.ok) { this.#reads.failed("daily", this.#clock(), events, r.error); st.dailyRetryAt = this.#clock() + this.#config.maxObservationGapMs; return; }
    this.#reads.succeeded("daily", this.#clock(), events);
    const head = prepareDay(r.value.bars, this.#config), atr14 = head.atr === null ? null : Math.round(head.atr * 1e4) / 1e4;
    const evidence = { runawayGate: head.gate, atr14, ...(head.runaway ? { evidence: head.runaway.evidence } : {}) };
    if (head.unavailable) {
      // Missing or stale history is not a failed rule. A stale feed (yesterday not in yet at 9:25) is read again while there is time; the gate settles it.
      st.lastUnavailable = head.unavailable;
      if (head.unavailable.reason === "stale_daily_history") { st.dailyRetryAt = this.#clock() + this.#config.maxObservationGapMs; return; }
      this.#settle(symbol, st, "unavailable", events, { reason: head.unavailable.reason, runawayGate: head.gate, ...head.unavailable.evidence }); return;
    }
    if (head.runaway && !head.runaway.fired) { st.head = head; this.#settle(symbol, st, "not_runaway", events, evidence); return; }
    st.head = head; st.anchorsPending = this.#config.useAnchoredVwaps ? head.daily.time.slice(-this.#config.vwapMaxSessionsBack).reverse() : [];
    // With the gate off the stock is only watched: "runaway" is never claimed for it.
    events.push({ type: "universe_checked", data: { symbol, runaway: head.runaway ? true : null, status: head.runaway ? "runaway" : "watched", sessions: head.daily.time.length, ...evidence } });
    if (!st.anchorsPending.length) this.#ready(symbol, st, events);
  }
  #anchorArrived(symbol: string, date: string, r: { ok: true; value: unknown } | { ok: false; error: unknown }, events: PaperEvent[]): void {
    const st = this.#symbols.get(symbol)!;
    if (st.phase !== "loading" || !st.anchorsPending.includes(date)) return;
    st.anchorsPending = st.anchorsPending.filter(d => d !== date);
    if (!r.ok) { this.#reads.failed("bars", this.#clock(), events, r.error); st.anchorsMissing.push(date); }
    else {
      this.#reads.succeeded("bars", this.#clock(), events);
      const result = ((r.value as any)?.data?.results ?? []).find((x: any) => x?.symbol === symbol && x?.interval === "minute");
      if (!Array.isArray(result?.bars)) st.anchorsMissing.push(date); else st.prior.push(...vwapBars(result.bars));
    }
    if (!st.anchorsPending.length) this.#ready(symbol, st, events);
  }
  /** The terminal verdict of a symbol that will not be scanned (journaled once). */
  #settle(symbol: string, st: SymbolState, phase: "unavailable" | "not_runaway", events: PaperEvent[], data: Record<string, unknown>): void {
    st.phase = phase;
    events.push({ type: "universe_checked", data: { symbol, runaway: phase === "not_runaway" ? false : null, status: phase, ...data } });
  }
  /** Everything a symbol needs is in: journal its supports and start scanning it. */
  #ready(symbol: string, st: SymbolState, events: PaperEvent[]): void {
    const head = st.head!, c = this.#config;
    st.phase = "ready"; st.scanner = new BoxScanner(head.atr!, c);
    // As of the open: today's minutes do not exist yet, so only the sessions before the day.
    const vwaps = anchoredVwaps(st.prior, head.daily, { ...c, vwapIncludesToday: 0 }, this.#session.open);
    const all = [...head.supports, ...vwaps];
    events.push({ type: "supports", data: { symbol, asOf: "before_open", supports: all.map(shownSupport), ...(all.length ? {} : { reason: "no_supports", note: "no box can form without a support" }), vwapAnchorsMissing: st.anchorsMissing,
      vwapIncludesToday: c.vwapIncludesToday === 1 } });
  }
  /** At 9:32 whatever is still unread is settled: no box is searched for a stock whose verdict is not in. */
  #openGate(events: PaperEvent[]): void {
    this.#gateOpened = true;
    for (const [symbol, st] of this.#symbols) {
      if (st.phase !== "loading") continue;
      if (st.head === null) { this.#settle(symbol, st, "unavailable", events, st.lastUnavailable ? { reason: st.lastUnavailable.reason, ...st.lastUnavailable.evidence, lastRead: "before_open" } : { reason: "not_read_before_open" }); continue; }
      st.anchorsMissing.push(...st.anchorsPending); st.anchorsPending = [];
      this.#ready(symbol, st, events);
    }
  }

  // ---- From 9:32: candles from observed trades (ADR 0001, 0002) and the scanner.
  #observe(q: Awaited<ReturnType<PaperMarket["quotes"]>>[number], now: number, events: PaperEvent[]): void {
    const st = this.#symbols.get(q.symbol)!, c = this.#config, fresh = freshTrade(q, now, c.maxQuoteAgeMs);
    this.#latest.set(q.symbol, { price: q.price, tradeAt: q.tradeAt, fresh });
    if (!validTrade(q, now)) return;
    const tradeMs = Date.parse(q.tradeAt!), length = c.candleMinutes * 60000;
    // Bucketed by the trade's own time, once per distinct trade, and before candles are harvested: the trade that finishes a
    // candle is still inside it when it printed before the end.
    const slot = Math.floor((tradeMs - this.#grid) / length);
    // A slot below the candle still open has already been harvested: a trade that first shows up after its candle closed is not counted.
    if (fresh && tradeMs >= this.#grid && tradeMs > st.lastTradeCounted && slot >= (st.candles.nextEnd - this.#grid) / length - 1) {
      st.lastTradeCounted = tradeMs;
      const held = st.slots.get(slot);
      st.slots.set(slot, held ? { high: Math.max(held.high, q.price!), low: Math.min(held.low, q.price!), trades: held.trades + 1 } : { high: q.price!, low: q.price!, trades: 1 });
    }
    for (const close of observeCandles(st.candles, q.price!, tradeMs, Date.parse(q.retrievedAt), c.candleMinutes, c.maxQuoteAgeMs, c.maxObservationGapMs, fresh)) {
      const slot = (close.start - this.#grid) / length, seen = st.slots.get(slot); st.slots.delete(slot);
      const known = close.close !== null && seen !== undefined && seen.trades >= c.minCandleTrades;
      if (!known) {
        st.counts.unobserved++;
        events.push({ type: "candle_unobserved", data: { symbol: q.symbol, candleStart: iso(close.start), candleEnd: iso(close.end), reason: close.close === null ? "not_observed" : "sparse",
          distinctTrades: seen?.trades ?? 0, minCandleTrades: c.minCandleTrades } });
      }
      st.queue.push({ start: close.start, end: close.end, high: seen?.high ?? NaN, low: seen?.low ?? NaN, close: known ? close.close : null });
    }
  }
  /** Push queued candles into the scanner, in order. A candle whose supports need today's minute bars waits for them. */
  #drain(symbol: string, st: SymbolState, now: number, events: PaperEvent[]): void {
    const c = this.#config, head = st.head!;
    const supportsAt = (asOf: number): Support[] => {
      if (c.useAnchoredVwaps && c.vwapIncludesToday && !st.degraded && !st.closing && (!st.today || st.today.fetchedAt < asOf)) throw new NeedsData("today's minute bars");
      return [...head.supports, ...anchoredVwaps([...st.prior, ...(st.today?.bars ?? [])], head.daily, c, asOf)];
    };
    while (st.queue.length) {
      let out: BoxEvent[];
      try { out = st.scanner!.push(st.queue[0]!, supportsAt); }
      catch (error) {
        if (!(error instanceof NeedsData)) throw error;
        // The candle waits for a read, which #scheduleToday hands out. Waiting a whole candle is its own event: the symbol
        // degrades (its VWAP falls back to the prior sessions) so its candles stay live instead of queueing until the close.
        if (st.waitingSince === null) st.waitingSince = now;
        if (now - st.waitingSince < c.candleMinutes * 60000) return;
        st.degraded = true; st.degradedReason = "no_read_slot"; st.waitingSince = null;
        continue;
      }
      st.waitingSince = null;
      const candle = st.queue.shift()!;
      for (const e of out) events.push(this.#journal(symbol, st, e, candle, supportsAt));
    }
  }
  // The state of today's minute bars, and the one event allowed to change each piece (every row has a test):
  //   inflight `today:S`   a read launched (added) / a read arrived (removed)
  //   todayAttempts        +1 when a read is actually LAUNCHED (never when the cap turns it away); 0 when a read succeeds
  //   todayRetryAt         a launched read failed: now + one poll before degrading, now + the backoff once degraded
  //   todayBackoffMs       doubled when a read fails while degraded (cap 60 s); reset when a read succeeds
  //   degraded             true: a launched read failed and todayAttempts is at or above the cap (it keeps counting while degraded),
  //                        or the head candle waited a whole candle for a read (degradedReason "no_read_slot"); false: a read succeeded
  //   waitingSince         the head candle first needed today's bars (set); the head candle was processed or the wait degraded (cleared)
  //   read slots           handed out only by #scheduleToday: waiting candles before recovery reads, rotating the first symbol each poll
  //   today (bars, fetchedAt)   a read succeeded
  //   closing              the session close (the last candles use what there is); journaled as degraded only for a candle the bars in hand do not cover
  /** Read today's minute bars in the background; true when a read was launched. A success makes them current and clears any degradation. */
  #fetchToday(symbol: string, st: SymbolState, now: number): boolean {
    // Today's bars share the prefetch's cap on reads in flight, so twenty stocks cannot ask at once; a symbol that is refused waits for its next turn, and nothing is counted.
    if ([...this.#inflight].filter(k => k.startsWith("today:")).length >= MAX_IN_FLIGHT) return false;
    st.todayAttempts++;
    this.#launch(`today:${symbol}`, TODAY_READ_DEADLINE_MS, () => this.#market.bars([symbol], this.#session.open, now, false), (r, startedAt, ev) => {
      const result = r.ok ? ((r.value as any)?.data?.results ?? []).find((x: any) => x?.symbol === symbol && x?.interval === "minute") : undefined;
      if (r.ok && Array.isArray(result?.bars)) {
        this.#reads.succeeded("bars", this.#clock(), ev);
        st.today = { fetchedAt: startedAt, bars: vwapBars(result.bars) }; st.todayAttempts = 0; st.degraded = false; st.degradedReason = null; st.todayBackoffMs = this.#config.maxObservationGapMs;
      } else {
        this.#reads.failed("bars", this.#clock(), ev, r.ok ? new Error("No minute bars for the day") : r.error);
        if (st.todayAttempts >= MAX_TODAY_ATTEMPTS && !st.degraded) { st.degraded = true; st.degradedReason = "reads_failed"; }
        // A short pause between the first tries (the candle is waiting); once degraded, a doubling backoff.
        st.todayRetryAt = this.#clock() + (st.degraded ? st.todayBackoffMs : this.#config.pollMs);
        if (st.degraded) st.todayBackoffMs = Math.min(st.todayBackoffMs * 2, MAX_TODAY_BACKOFF_MS);
      }
      this.#drain(symbol, st, this.#clock(), ev);
    });
    return true;
  }
  /** The one place today's-bars reads are handed out. Free slots go first to symbols with a candle waiting, then to degraded
   *  symbols retrying on their backoff; the first symbol rotates each poll, so no symbol is starved when reads hang. */
  #scheduleToday(now: number): void {
    const ready = [...this.#symbols].filter(([, st]) => st.phase === "ready");
    if (!ready.length) return;
    const start = this.#rotation++ % ready.length, order = [...ready.slice(start), ...ready.slice(0, start)];
    const due = ([symbol, st]: [string, SymbolState]) => !this.#inflight.has(`today:${symbol}`) && now >= st.todayRetryAt;
    const waiting = order.filter(e => e[1].waitingSince !== null && due(e)), recovering = order.filter(e => e[1].degraded && e[1].waitingSince === null && due(e));
    for (const [symbol, st] of [...waiting, ...recovering]) if (!this.#fetchToday(symbol, st, now)) return;   // false: every slot is taken
  }
  #journal(symbol: string, st: SymbolState, e: BoxEvent, candle: Candle, _supportsAt: unknown): PaperEvent {
    st.counts[e.type === "formed" ? "formed" : e.type === "decided" ? "decided" : "voided"]++;
    // The last minute the VWAP could see: bars lag, so this may be earlier than the candle's end.
    const through = st.today ? Math.max(0, ...st.today.bars.filter(b => b.at + 60000 <= candle.end).map(b => b.at + 60000)) : 0;
    return { type: `box_${e.type}`, data: { symbol, rangesFrom: "observed_trades", vwapThrough: through ? iso(through) : null, vwapTodayDegraded: st.degraded || (st.closing && !(st.today && st.today.fetchedAt >= candle.end)),
      vwapTodayDegradedReason: st.degraded ? st.degradedReason : st.closing && !(st.today && st.today.fetchedAt >= candle.end) ? "session_close" : null, ...e.record } };
  }

  // ---- The close.
  #finish(events: PaperEvent[]): void {
    for (const [symbol, st] of this.#symbols) {
      if (st.phase !== "ready") continue;
      st.closing = true; this.#drain(symbol, st, this.#clock(), events);
      const live = st.scanner!.live();
      if (live) { st.counts.expired++; events.push({ type: "box_expired", data: { symbol, rangesFrom: "observed_trades", ...(live as BoxRecord) } }); }
    }
    this.#complete = true;
    events.push({ type: "session_ended", data: { watchOnly: true, ordersSubmitted: 0, positions: 0,
      symbols: Object.fromEntries([...this.#symbols].map(([s, st]) => [s, { phase: st.phase, ...st.counts }])) } });
  }
}

