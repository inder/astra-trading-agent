import { createHash } from "node:crypto";
import { closeSync, constants, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { agentStrategies, type AgentStrategy, type SampleResult } from "./agent-strategies.ts";

export interface SampleRequest { strategyId: string; symbols: string[]; includePremarket: boolean; requestId: string }
export interface AgentRun extends SampleResult {
  id: string; requestHash: string; strategyId: string; strategyVersion: string;
  createdAt: string; status: "completed"; mode: "synthetic_sample"; config: unknown;
}
const validId = (id: string) => typeof id === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(id);

/** One customer-owned data directory. No global selected configuration or broker state. */
export class TradingAgentService {
  readonly dataDirectory: string;
  readonly strategies: readonly AgentStrategy[];
  constructor(dataDirectory: string, strategies: readonly AgentStrategy[] = agentStrategies) {
    this.dataDirectory = resolve(dataDirectory); this.strategies = strategies;
    if (new Set(strategies.map(s => s.id)).size !== strategies.length) throw new Error("Duplicate strategy ID");
  }
  readiness() {
    return { server: "ready", mode: "sample_only", brokerage: "not_connected",
      requiresOpenAIKey: false, capabilities: ["strategy_discovery", "configuration_preview", "synthetic_sample_runs", "run_history"],
      unavailable: ["broker_authorization", "live_market_data", "market_hours_paper_runner", "real_orders", "position_mutations"],
      onboarding: [
        "Discover strategies and preview a configuration without credentials.",
        "Run the bundled synthetic sample and inspect its events.",
        "Independent Robinhood authorization is not implemented in this distribution. Do not paste brokerage credentials into chat.",
      ] };
  }
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
