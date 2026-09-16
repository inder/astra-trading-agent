import { createHash } from "node:crypto";
import { closeSync, constants, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { agentStrategies, type AgentStrategy, type SampleResult } from "./agent-strategies.ts";
import { RobinhoodConnection } from "./broker-connection.ts";
import { RobinhoodMarketData, validateSymbols } from "./market-data.ts";
import { levels, parseLevelsSettings, type DailyBars, type Levels, type LevelsSettings, type Timeframe } from "./levels.ts";
import { RobinhoodPaperMarket, type PaperMarket } from "./paper-market.ts";
import { PaperController } from "./paper-controller.ts";
import { PaperReviews } from "./paper-reviews.ts";
import { entryCapacity, setupGuide, type GuideRun } from "./setup-guide.ts";
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
  /** Support and resistance for stocks, from daily bars: no account is read, and nothing is advice. One bar read per
   *  stock per day is kept in memory, pinned to the split adjustment it was fetched with. */
  async levels(symbols: string[], timeframe?: Timeframe): Promise<SymbolLevels[]> {
    validateSymbols(symbols);
    if (!this.#ready()) throw new Error("Connect Robinhood market data first");
    const now = this.#clock(), today = new Date(now).toISOString().slice(0, 10);
    const quotes = await this.market.quotes(symbols).catch(() => [] as { symbol: string; price: number | null; fresh: boolean }[]);
    const out: SymbolLevels[] = [];
    for (const symbol of symbols) {
      const cached = this.#dailyBars.get(symbol);
      let bars = cached?.on === today ? cached.bars : undefined;
      if (!bars) {
        try {
          // Two years for the longest window, plus a run-up for the 200-day average and for swing points at its edge.
          bars = await this.market.dailyBars(symbol, now - 1000 * 86400000, now);
          this.#dailyBars.set(symbol, { on: today, bars });
        } catch (error) {
          out.push({ symbol, unavailable: error instanceof Error && /unavailable|Invalid|Duplicate|order/.test(error.message)
            ? "no usable daily price history from Robinhood" : "daily price history could not be read" });
          continue;
        }
      }
      const quote = quotes.find(q => q.symbol === symbol);
      const computed = levels(bars, this.#levelsSettings, quote?.fresh && quote.price ? quote.price : undefined);
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
