import { createHash } from "node:crypto";
import { closeSync, constants, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { agentStrategies, type AgentStrategy, type SampleResult } from "./agent-strategies.ts";
import { RobinhoodConnection } from "./broker-connection.ts";
import { DailyBarsError, RobinhoodMarketData, sessionsBefore, validateSymbols } from "./market-data.ts";
import { normalizeAccounts, type AccountSummary } from "./portfolio.ts";
import { addDays, isTradingDay, sessionTimes } from "./daily-history.ts";
import { levels, parseLevelsSettings, type DailyBars, type Levels, type LevelsSettings, type Timeframe } from "./levels.ts";
import { RobinhoodPaperMarket, type PaperMarket } from "./paper-market.ts";
import { PaperController } from "./paper-controller.ts";
import { PaperReviews } from "./paper-reviews.ts";
import { entryCapacity, etDate, setupGuide, type GuideRun } from "./setup-guide.ts";
import { checkSymbols, type SymbolSource } from "./symbol-check.ts";

export interface SampleRequest { strategyId: string; symbols: string[]; includePremarket: boolean; requestId: string }
export interface AgentRun extends SampleResult {
  id: string; requestHash: string; strategyId: string; strategyVersion: string;
  createdAt: string; status: "completed"; mode: "synthetic_sample"; config: unknown;
}
const validId = (id: string) => typeof id === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(id);

/** One customer-owned data directory. No global selected configuration or broker state. */
/** One stock's levels, or why there are none for it. `requested` is the timeframe the caller asked to be shown. */
export type SymbolLevels = ({ symbol: string } & Levels & { requested?: Timeframe }) | { symbol: string; unavailable: string };
export class TradingAgentService {
  readonly dataDirectory: string;
  readonly strategies: readonly AgentStrategy[];
  readonly broker: RobinhoodConnection;
  readonly market: RobinhoodMarketData;
  readonly paper: PaperController;
  readonly reviews: PaperReviews;
  #closing?: Promise<void>;
  #clock: () => number; #ready: () => boolean; #symbols: SymbolSource;
  #dailyBars = new Map<string, { on: string; bars: DailyBars }>();
  #levelsSettings: LevelsSettings = parseLevelsSettings();
  // Account numbers never enter the chat: callers hold a handle that is random for this process and forgotten when it
  // exits. Nothing here is written to disk, and nothing is derived from the account number.
  #accountHandles = new Map<string, string>();
  #handleFor(accountNumber: string) {
    for (const [handle, number] of this.#accountHandles) if (number === accountNumber) return handle;
    const handle = `acct_${randomUUID().slice(0, 8)}`;
    this.#accountHandles.set(handle, accountNumber);
    return handle;
  }
  /** The user's accounts, masked. Reads `get_accounts` and nothing else. */
  async accounts(): Promise<AccountSummary[]> {
    if (!this.broker.status().accountToolsAvailable) throw new Error("Robinhood did not grant account access to this connection");
    return normalizeAccounts(await this.broker.accountRead("get_accounts", {}), n => this.#handleFor(n));
  }
  /** Account numbers for handles minted in this process. An unknown handle is refused rather than guessed, so a
   *  fabricated one reads no account. */
  accountNumbers(handles: string[]): string[] {
    if (!Array.isArray(handles) || !handles.length || handles.length > 20) throw new Error("Choose between 1 and 20 accounts");
    return handles.map(handle => {
      const accountNumber = this.#accountHandles.get(handle);
      if (!accountNumber) throw new Error("Unknown account. List the accounts first, then choose from that list.");
      return accountNumber;
    });
  }
  // Calendar days of history to request: the weekly frame's years plus a year of run-up, so one read serves every
  // timeframe. Weekends and holidays are included in the span, not in what comes back.
  get #historyDays() { return Math.round((this.#levelsSettings.weeklyYears + 1) * 365.25); }
  constructor(dataDirectory: string, strategies: readonly AgentStrategy[] = agentStrategies, broker = new RobinhoodConnection(),
    testing: { market?: PaperMarket; symbols?: SymbolSource; ready?: () => boolean; clock?: () => number; auto?: boolean } = {}) {
    this.dataDirectory = resolve(dataDirectory); this.strategies = strategies;
    this.broker = broker; this.market = new RobinhoodMarketData(broker);
    if (new Set(strategies.map(s => s.id)).size !== strategies.length) throw new Error("Duplicate strategy ID");
    const live = new RobinhoodPaperMarket(broker);
    this.#clock = testing.clock ?? Date.now; this.#ready = testing.ready ?? (() => this.broker.status().paperDataAvailable);
    this.#symbols = testing.symbols ?? live;
    this.paper = new PaperController(this.dataDirectory, strategies, testing.market ?? live, this.#ready, testing.clock, testing.auto);
    this.reviews = new PaperReviews(this.paper);
  }
  /** The next step for the user, from live broker and run state. */
  guide() {
    const status = this.broker.status(), runs: GuideRun[] = [], unreadable: string[] = [];
    // One unreadable record is named and left out rather than taking the guide down; its state is never guessed.
    for (const id of this.paper.ids()) {
      try {
        const r = this.paper.status(id);
        // Whether it can still enter, from the strategy's own state (a resumed run, or one at its stock limit, can't).
        const capacity = entryCapacity(r.view.detail, r.config);
        // Completed runs are history; only the others need their saved plan.
        runs.push({ runId: id, strategyId: r.strategyId, date: r.date, status: r.status, attached: r.attached, needsSettlement: r.needsSettlement,
          positions: r.view.positions.length, ...(capacity ?? {}), ...(r.status === "completed" ? {} : { at: r.at, config: r.config }) });
      } catch { unreadable.push(id); }
    }
    return setupGuide({ now: this.#clock(), strategyId: this.strategies.find(s => s.paperFactory)?.id ?? "", runs, unreadable,
      broker: { state: status.state, paperDataAvailable: this.#ready(), authorizationExpiresAt: status.authorizationExpiresAt } });
  }
  /** Tickers checked against the session the guide would plan next. */
  async checkSymbols(symbols: string[]) {
    if (!this.#ready()) throw new Error("Connect Robinhood market data first");
    const date = this.guide().session?.date;
    if (!date) throw new Error("No supported session to check against");
    return checkSymbols(this.#symbols, symbols, date);
  }
  /** The last session whose bar is final: today's, once it has closed, and otherwise the day before. A day still
   *  trading has a half-formed bar. An uncovered calendar year is treated as still trading, so a provisional bar is
   *  never mistaken for a settled one. */
  #settledThrough(now: number) {
    const today = etDate(now);
    try { return !isTradingDay(today) || now >= sessionTimes(today).close ? today : addDays(today, -1); }
    catch { return addDays(today, -1); }
  }
  /** Support and resistance for stocks, from daily bars: no account is read, and nothing is advice. One bar read per
   *  stock per settled session is kept in memory, pinned to the split adjustment it was fetched with. */
  async levels(symbols: string[], timeframe?: Timeframe): Promise<SymbolLevels[]> {
    validateSymbols(symbols);
    if (!this.#ready()) throw new Error("Connect Robinhood market data first");
    const now = this.#clock(), settled = this.#settledThrough(now);
    // A timeframe nobody configured is still answerable when it is asked for by name — that is how the weekly frame,
    // which is deliberately absent from a written answer, is reached.
    const settings = timeframe && !this.#levelsSettings.timeframes.includes(timeframe)
      ? { ...this.#levelsSettings, timeframes: [...this.#levelsSettings.timeframes, timeframe] } : this.#levelsSettings;
    for (const [key, held] of this.#dailyBars) if (held.on !== settled) this.#dailyBars.delete(key);   // yesterday's bars are dead weight
    const quotes = await this.market.quotes(symbols).catch(() => [] as { symbol: string; price: number | null; fresh: boolean }[]);
    const out: SymbolLevels[] = [];
    for (const symbol of symbols) {
      const cached = this.#dailyBars.get(symbol);
      let bars = cached?.on === settled ? cached.bars : undefined;
      if (!bars) {
        try {
          // Enough for the longest window anyone can ask for — the weekly frame's years, plus a run-up for the
          // 200-day average and for swing points at the window's edge. One span for every caller, so a request that
          // only needs two years cannot poison the cache for one that needs five.
          // Today's forming bar is dropped rather than measured: its high, low and close are all still provisional.
          bars = sessionsBefore(await this.market.dailyBars(symbol, now - this.#historyDays * 86400000, now), addDays(settled, 1));
          this.#dailyBars.set(symbol, { on: settled, bars });
        } catch (error) {
          out.push({ symbol, unavailable: error instanceof DailyBarsError
            ? "no usable daily price history from Robinhood" : "daily price history could not be read" });
          continue;
        }
      }
      const quote = quotes.find(q => q.symbol === symbol);
      // `settled` advances through weekends and holidays, which is what tells a weekly frame that a week with no
      // Friday session is nonetheless over.
      const computed = levels(bars, settings, quote?.fresh && quote.price ? quote.price : undefined, settled);
      out.push({ symbol, ...computed, requested: timeframe ?? computed.defaultTimeframe ?? undefined });
    }
    return out;
  }
  close() {
    return this.#closing ??= (async () => {
      try { await this.reviews.close(); } finally {
        try { await this.paper.close(); } finally { await this.broker.close(); }
      }
    })();
  }
  readiness() {
    return { server: "ready", mode: "sample_and_paper", brokerage: this.broker.status().state,
      brokerDetails: this.broker.status(),
      requiresOpenAIKey: false, capabilities: ["strategy_discovery", "configuration_preview", "synthetic_sample_runs", "run_history", "browser_authorization", "connected_equity_quotes", "continuous_paper_runs", "paper_pnl", "browser_reviewed_paper_position_changes", "explicit_recovery"],
      unavailable: ["real_orders", "brokerage_position_mutations"],
      guide: this.#guideOrNull() };
  }
  // Readiness must answer even when run storage can't be read.
  #guideOrNull() { try { return this.guide(); } catch { return null; } }
  catalog() { return this.strategies.map(({ id, version, name, description, capabilities }) => ({ id, version, name, description, capabilities })); }
  #strategy(id: string) {
    const strategy = this.strategies.find(s => s.id === id);
    if (!strategy) throw new Error("Strategy is not available in this distribution");
    return strategy;
  }
  preview(strategyId: string, symbols: string[], includePremarket: boolean) {
    if (typeof includePremarket !== "boolean") throw new Error("includePremarket must be boolean");
    const strategy = this.#strategy(strategyId);
    return { strategyId, strategyVersion: strategy.version, mode: "synthetic_sample", config: strategy.preview({
      date: "2026-09-08", symbols, includePremarketLeadMinutes: includePremarket ? 2 : 0,
    }), started: false };
  }
  runSample(request: SampleRequest): AgentRun {
    if (!validId(request.requestId)) throw new Error("Invalid request ID");
    const preview = this.preview(request.strategyId, request.symbols, request.includePremarket);
    const hash = createHash("sha256").update(JSON.stringify(preview)).digest("hex");
    const runsDirectory = join(this.dataDirectory, "runs");
    mkdirSync(runsDirectory, { recursive: true, mode: 0o700 });
    const destination = join(runsDirectory, `${request.requestId}.json`);
    const existing = () => {
      const old = this.getRun(request.requestId);
      if (old.requestHash !== hash) throw new Error("Request ID already used with different configuration");
      return old;
    };
    try { return existing(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const result = this.#strategy(request.strategyId).runSample(preview.config);
    const run: AgentRun = { id: request.requestId, requestHash: hash, strategyId: request.strategyId,
      strategyVersion: preview.strategyVersion, createdAt: new Date().toISOString(), status: "completed", mode: "synthetic_sample",
      config: preview.config, ...result };
    // Complete event log and snapshot become visible together, without overwrite.
    // Competing processes may compute a harmless sample twice, but publish once.
    const temporary = join(runsDirectory, `.pending-${randomUUID()}`);
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try { writeFileSync(fd, JSON.stringify(run, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
    try {
      try { linkSync(temporary, destination); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return existing(); throw error; }
      const dir = openSync(runsDirectory, constants.O_RDONLY);
      try { fsyncSync(dir); } finally { closeSync(dir); }
      return run;
    } finally { unlinkSync(temporary); }
  }
  getRun(id: string): AgentRun {
    if (!validId(id)) throw new Error("Invalid run ID");
    const fd = openSync(join(this.dataDirectory, "runs", `${id}.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const run = JSON.parse(readFileSync(fd, "utf8")) as AgentRun;
      if (run.id !== id || run.mode !== "synthetic_sample" || run.status !== "completed" || !Array.isArray(run.events))
        throw new Error("Invalid saved run; not safe to reuse");
      return run;
    } finally { closeSync(fd); }
  }
  listRuns() {
    let files: string[];
    try { files = readdirSync(join(this.dataDirectory, "runs")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    return files.filter(f => f.endsWith(".json") && validId(f.slice(0, -5))).sort().map(f => {
      const { id, strategyId, strategyVersion, createdAt, status, mode } = this.getRun(f.slice(0, -5));
      return { id, strategyId, strategyVersion, createdAt, status, mode };
    });
  }
}
