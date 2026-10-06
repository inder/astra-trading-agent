import { z } from "zod";
import type { ChartStore } from "./chart-store.ts";
import { sessionTimes, isTradingDay } from "./daily-history.ts";
import { minuteWindows, normalizeMinuteBars, sessionsThrough, type MinuteBar, type Session } from "./intraday-bars.ts";
import { validateSymbols, type EquityMarketQuote } from "./market-data.ts";
import { etDate } from "./setup-guide.ts";

/** What the live chart reads. Market data only; the production source is Astra's allowlisted Robinhood connection. */
export interface ChartSource {
  quotes(symbols: string[]): Promise<EquityMarketQuote[]>;
  /** Raw `get_equity_historicals` reply for regular-session minute bars in [start, end). */
  minuteBars(symbol: string, start: number, end: number): Promise<unknown>;
}

/** Every number the live chart runs on is a setting with a default. */
export const chartSettingsSchema = z.object({
  /** Seconds between quote reads while the market is open. One read covers every charted symbol. */
  pollSeconds: z.number().min(1).max(30).default(2),
  /** Seconds between re-reads of today's official minute bars, which replace the quote-built ones. */
  refreshSeconds: z.number().int().min(15).max(600).default(60),
  /** Past sessions of minute bars fetched when a symbol is first charted, if the store does not hold them. */
  backfillSessions: z.number().int().min(1).max(30).default(5),
  /** Days of minute bars kept in the store. */
  retentionDays: z.number().int().min(1).max(365).default(90),
  /** Most symbols charted live at once. Robinhood's quote batch takes 20 at most. */
  maxSymbols: z.number().int().min(1).max(20).default(10),
  /** Seconds without a successful quote read, during the session, before the page is told prices are stale. */
  staleSeconds: z.number().int().min(5).max(120).default(15),
}).strict();
export type ChartSettings = z.infer<typeof chartSettingsSchema>;

/** `connecting` is the session before the first quote read has answered: not yet live, and not stale either. */
export type ChartState = "connecting" | "live" | "closed" | "stale";
export type ChartEvent =
  | { type: "bar"; bar: MinuteBar; price: number; tradeAt: string }
  /** The store's whole state for [from, to): a page REPLACES its bars in that window with these. */
  | { type: "bars"; from: number; to: number; bars: MinuteBar[] }
  /** Robinhood keeps refusing to quote this symbol. Not final: retries continue, and a status follows if it answers.
   *  `final` is set only when the subscription itself was refused, and only then does the page stop listening. */
  | { type: "error"; message: string; final?: true }
  | { type: "status"; state: ChartState; lastQuoteAt: string | null };
export type ChartListener = (event: ChartEvent) => void;

export interface IntradayHistory { symbol: string; bars: MinuteBar[]; sessions: Session[]; today: Session | null; warnings: string[] }

/** Live minute bars for the charts open in a browser.
 *
 *  Robinhood's MCP answers requests and has no stream, so "live" is a single poll loop here, pushed to every open
 *  page: however many tabs chart a symbol, it costs one quote read per poll for ALL symbols together, plus one
 *  minute-bar read per symbol per refresh. Polling runs only during the regular session and only while some page is
 *  listening. */
export class LiveCharts {
  #store: ChartStore; #source: ChartSource; #settings: ChartSettings; #clock: () => number;
  #listeners = new Map<string, Set<ChartListener>>();
  #state = new Map<string, ChartState | "refused">();
  #lastQuoteAt: number | null = null;
  #lastPollOk: number | null = null;
  /** When the poll loop last started, so a loop that never gets an answer turns stale instead of connecting forever. */
  #loopStarted: number | null = null;
  #timers: NodeJS.Timeout[] = [];
  #polling = false; #refreshing = false;
  #loading = new Map<string, Promise<IntradayHistory>>();
  /** Symbols Robinhood would not quote on their own while others were quoted, with how many times in a row: left out of
   *  the batch so one bad ticker cannot stall every open chart. Never a final verdict — a good ticker can fail on a
   *  passing error or a rate limit — so each is asked for alone again every refresh and rejoins the batch the first
   *  time it answers. Its pages see it as stale at first; only a second failure in a row tells them to check the ticker. */
  #unquotable = new Map<string, number>();
  /** Until when a refused batch is not broken up again. Every fallback sets it: under a rate limit the batch and some
   *  single reads fail together, and breaking it up on every poll would multiply reads exactly when Robinhood pushes back. */
  #fallbackUntil = 0;
  constructor(store: ChartStore, source: ChartSource, settings: Partial<ChartSettings> = {}, clock = Date.now) {
    this.#store = store; this.#source = source; this.#settings = chartSettingsSchema.parse(settings); this.#clock = clock;
  }
  get settings() { return this.#settings; }
  #today(now = this.#clock()): Session | null {
    const date = etDate(now);
    try { return isTradingDay(date) ? { date, ...sessionTimes(date) } : null; } catch { return null; }
  }
  /** Everything stored for `symbol` within retention, after filling what the store is missing. Two pages loading the
   *  same symbol at once share one load, so the backfill is read once. */
  history(symbol: string): Promise<IntradayHistory> {
    validateSymbols([symbol]);
    const pending = this.#loading.get(symbol);
    if (pending) return pending;
    const load = this.#history(symbol).finally(() => this.#loading.delete(symbol));
    this.#loading.set(symbol, load);
    return load;
  }
  async #history(symbol: string): Promise<IntradayHistory> {
    const now = this.#clock(), today = this.#today(now), warnings: string[] = [];
    // The last `backfillSessions` sessions that have ended before today; today is refreshed separately.
    const recent = sessionsThrough(etDate(now), this.#settings.backfillSessions + 1)
      .filter(s => s.close <= now && s.date !== today?.date).slice(-this.#settings.backfillSessions);
    const missing = recent.filter(s => !this.#store.isComplete(symbol, s.date));
    let failed = 0;
    for (const w of minuteWindows(missing, recent)) {
      try {
        const bars = normalizeMinuteBars(await this.#source.minuteBars(symbol, w.start, w.end), symbol);
        this.#store.putOfficial(symbol, w.start, w.end, bars);
        // Read after these sessions closed, so what came back is all there is for them — unless nothing came back
        // for a session, which is as likely a passing blip as a day with no trades, and is left to be read again.
        for (const s of missing) if (s.open >= w.start && s.close <= w.end && bars.some(b => b.t >= s.open && b.t < s.close))
          this.#store.markComplete(symbol, s.date, s.close);
      } catch { failed++; }
    }
    if (failed) warnings.push("Some earlier minute history could not be read from Robinhood, so the intraday chart starts later than usual.");
    if (today && now >= today.open && !this.#store.isComplete(symbol, today.date)) {
      try { await this.#refreshToday(symbol, today, now); }
      catch { warnings.push("Today's minute bars could not be read from Robinhood; the chart shows what was stored before."); }
    }
    // Housekeeping only: a busy or failing prune must not cost the reader their chart.
    try { this.#store.prune(now - this.#settings.retentionDays * 86400000); } catch { /* next load prunes */ }
    const bars = this.#store.bars(symbol, now - this.#settings.retentionDays * 86400000, Number.MAX_SAFE_INTEGER);
    const dates = new Set(bars.map(b => etDate(b.t)));
    if (today) dates.add(today.date);
    const sessions = [...dates].sort().flatMap(date => { try { return [{ date, ...sessionTimes(date) }]; } catch { return []; } });
    return { symbol, bars, sessions, today, warnings };
  }
  /** Re-reads today's bars and stores the settled minutes as official.
   *
   *  Settled means ended at least a full minute before now. Robinhood marks its newest bar unsettled, and nothing
   *  captured says how soon after a minute ends its bar appears; settling the minute that ended a second ago would
   *  let a bar Robinhood has not published yet delete the provisional one in its place. Once the read happens a
   *  minute or more after the close, the whole session is settled and recorded as complete. */
  async #refreshToday(symbol: string, today: Session, now: number) {
    const settled = Math.min(today.close, Math.floor(now / 60000) * 60000 - 60000);
    if (settled <= today.open) return;
    const bars = normalizeMinuteBars(await this.#source.minuteBars(symbol, today.open, Math.min(now, today.close)), symbol);
    this.#store.putOfficial(symbol, today.open, settled, bars);
    if (settled >= today.close && bars.length) this.#store.markComplete(symbol, today.date, today.close);
    this.#emit(symbol, { type: "bars", from: today.open, to: today.close, bars: this.#store.bars(symbol, today.open, today.close) });
  }
  /** Starts pushing `symbol` to `listener`. Returns the function that stops it. */
  subscribe(symbol: string, listener: ChartListener): () => void {
    validateSymbols([symbol]);
    const set = this.#listeners.get(symbol) ?? new Set();
    if (!set.size && this.#listeners.size >= this.#settings.maxSymbols)
      throw new Error(`At most ${this.#settings.maxSymbols} symbols can be charted live at once; close a chart first.`);
    set.add(listener); this.#listeners.set(symbol, set);
    const view = this.#view(symbol);
    this.#state.set(symbol, view);
    listener(this.#viewEvent(symbol, view));
    this.#start();
    return () => {
      set.delete(listener);
      if (!set.size) { this.#listeners.delete(symbol); this.#state.delete(symbol); this.#unquotable.delete(symbol); }
      if (!this.#listeners.size) this.#stop();
    };
  }
  get symbols() { return [...this.#listeners.keys()]; }
  #start() {
    if (this.#timers.length) return;
    this.#loopStarted = this.#clock();
    this.#timers = [
      setInterval(() => void this.pollOnce(), this.#settings.pollSeconds * 1000),
      setInterval(() => void this.refreshOnce(), this.#settings.refreshSeconds * 1000),
    ];
    for (const t of this.#timers) t.unref();
  }
  // The last good poll is forgotten too: a page opened minutes later must start as connecting, not as stale.
  #stop() { for (const t of this.#timers) clearInterval(t); this.#timers = []; this.#loopStarted = null; this.#lastPollOk = null; }
  #iso(ms: number | null) { return ms === null ? null : new Date(ms).toISOString(); }
  #stateNow(now = this.#clock()): ChartState {
    const today = this.#today(now);
    if (!today || now < today.open || now >= today.close) return "closed";
    if (this.#lastPollOk === null || this.#lastPollOk < today.open)
      // Grace counts from the open at the earliest: a loop that idled through the night has not been waiting.
      return this.#loopStarted !== null && now - Math.max(this.#loopStarted, today.open) > this.#settings.staleSeconds * 1000 ? "stale" : "connecting";
    return now - this.#lastPollOk <= this.#settings.staleSeconds * 1000 ? "live" : "stale";
  }
  #emit(symbol: string, event: ChartEvent) {
    for (const listener of this.#listeners.get(symbol) ?? []) { try { listener(event); } catch { /* one page must not stop another */ } }
  }
  /** What one symbol's pages should be showing. The shared state, except that a left-out symbol is never "live" —
   *  nothing is arriving for it — and after repeated refusals it is an error the reader can act on. "closed" wins over
   *  both: the market's state is true for every symbol. */
  #view(symbol: string, now = this.#clock()): ChartState | "refused" {
    const state = this.#stateNow(now), failures = this.#unquotable.get(symbol);
    if (state === "closed" || failures === undefined) return state;
    return failures >= 2 ? "refused" : "stale";
  }
  #viewEvent(symbol: string, view: ChartState | "refused"): ChartEvent {
    return view === "refused"
      ? { type: "error", message: `Robinhood has no live quote for ${symbol} right now. Retrying every ${this.#settings.refreshSeconds} s; check the ticker if this stays.` }
      : { type: "status", state: view, lastQuoteAt: this.#iso(this.#lastQuoteAt) };
  }
  #announce(now: number) {
    for (const symbol of this.#listeners.keys()) {
      const view = this.#view(symbol, now);
      if (this.#state.get(symbol) === view) continue;
      this.#state.set(symbol, view);
      this.#emit(symbol, this.#viewEvent(symbol, view));
    }
  }
  /** One quote read for every charted symbol, folded into each one's current minute. Public for tests.
   *
   *  The status is re-announced on every tick, even while an earlier read is still outstanding: a read that hangs
   *  (the connection allows 20 s and more) must not leave pages saying "Live" with nothing arriving. */
  async pollOnce() {
    if (!this.#listeners.size) return;
    const now = this.#clock(), today = this.#today(now);
    if (this.#polling || !today || now < today.open || now >= today.close) { this.#announce(now); return; }
    this.#polling = true;
    try {
      const symbols = this.symbols.filter(s => !this.#unquotable.has(s));
      if (!symbols.length) return;
      const quotes = await this.#quotes(symbols);
      if (!quotes) return;
      this.#lastPollOk = this.#clock();
      for (const q of quotes) {
        const at = q.tradeAt ? Date.parse(q.tradeAt) : NaN;
        // A regular-session trade from today's session only: an after-hours print or yesterday's last trade must
        // never be drawn into today's candle.
        if (q.price === null || !q.regularSession || !(at >= today.open && at < today.close)) continue;
        this.#lastQuoteAt = Math.max(this.#lastQuoteAt ?? 0, at);
        let bar: MinuteBar | null = null;
        try { bar = this.#store.putTick(q.symbol, Math.floor(at / 60000) * 60000, q.price, at); } catch { continue; }
        if (bar) this.#emit(q.symbol, { type: "bar", bar, price: q.price, tradeAt: new Date(at).toISOString() });
      }
    } catch { /* reported as stale once staleSeconds pass without a good read */ }
    finally { this.#polling = false; this.#announce(this.#clock()); }
  }
  /** The batch, or, when the batch is refused, each symbol on its own. Robinhood refuses a whole batch over one ticker
   *  it cannot quote. Asked one at a time, a symbol that fails while others succeed is the bad one: its pages are told,
   *  and it leaves the batch. When every one fails it is the connection, not a ticker, and nobody is blamed. */
  async #quotes(symbols: string[]): Promise<EquityMarketQuote[] | null> {
    try { return await this.#source.quotes(symbols); }
    catch (error) {
      if (symbols.length === 1 || this.#clock() < this.#fallbackUntil) throw error;
    }
    this.#fallbackUntil = this.#clock() + 30000;
    const answers = await Promise.all(symbols.map(s => this.#source.quotes([s]).then(q => ({ s, q }), () => ({ s, q: null }))));
    const good = answers.filter(a => a.q !== null);
    if (!good.length) return null;                               // every one failed: the connection, not a ticker
    // Only symbols someone is still watching: a blame recorded for a closed chart would greet its next page.
    for (const { s } of answers) if (answers.find(a => a.s === s)!.q === null && this.#listeners.has(s)) this.#unquotable.set(s, 1);
    return good.flatMap(a => a.q!);
  }
  /** Each left-out symbol, asked for alone once more. Public for tests. */
  async retryUnquotable() {
    // In parallel: one at a time, each slow read would hold back the official-bar refresh for every symbol.
    await Promise.all([...this.#unquotable.keys()].map(async s => {
      const answered = await this.#source.quotes([s]).then(() => true, () => false);
      if (!this.#unquotable.has(s)) return;
      if (answered) this.#unquotable.delete(s); else this.#unquotable.set(s, this.#unquotable.get(s)! + 1);
    }));
    this.#announce(this.#clock());
  }
  /** Re-reads today's official minute bars for every charted symbol. Public for tests. */
  async refreshOnce() {
    if (this.#refreshing || !this.#listeners.size) return;
    const now = this.#clock(), today = this.#today(now);
    // Runs a little past the close, so the last minutes settle into official bars.
    if (!today || now < today.open || now > today.close + 3 * 60000) return;
    this.#refreshing = true;
    try {
      await this.retryUnquotable();
      for (const symbol of this.symbols) if (!this.#unquotable.has(symbol)) await this.#refreshToday(symbol, today, now).catch(() => undefined);
    }
    finally { this.#refreshing = false; }
  }
  close() { this.#stop(); this.#listeners.clear(); }
}
