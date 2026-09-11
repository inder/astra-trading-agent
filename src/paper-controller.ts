import { closeSync, constants, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import type { AgentStrategy } from "./agent-strategies.ts";
import type { PaperMarket } from "./paper-market.ts";
import { StepError, type PaperRuntime, type PaperControl, type PaperEvent } from "./paper-runtime.ts";
import { sessionTimes } from "./orb-paper-runtime.ts";
import type { StrategySettings } from "./orb-config.ts";

export interface PaperSetup extends StrategySettings { runId: string; strategyId: string; date: string; symbols: string[]; includePremarket: boolean }
export interface PaperRecord {
  runId: string; strategyId: string; version: string; date: string; config: unknown; configHash: string; revision: number;
  status: "configured" | "running" | "stopped" | "completed" | "error"; at: string; checkpoint: unknown;
  events: PaperEvent[]; view: ReturnType<PaperRuntime["view"]>; mode: "paper"; ordersSubmitted: 0;
}
const validId = (id: string) => /^[a-zA-Z0-9_-]{1,64}$/.test(id);
/** Mark staleness for strategies that do not configure a quote age of their own. */
const DEFAULT_MARK_STALE_MS = 5000;
function readJSON(path: string) { const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { return JSON.parse(readFileSync(fd, "utf8")); } finally { closeSync(fd); } }
function publish(path: string, value: unknown) {
  const tmp = path + "." + randomUUID() + ".tmp";
  const fd = openSync(tmp, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  try { linkSync(tmp, path); } finally { unlinkSync(tmp); }
  const dir = openSync(dirname(path), constants.O_RDONLY);
  try { fsyncSync(dir); } finally { closeSync(dir); }
}
type Active = { runtime: PaperRuntime; record: PaperRecord; timer?: NodeJS.Timeout };

/** Common lifecycle and audit layer; strategy-specific behavior comes from the registry. */
export class PaperController {
  #root: string; #strategies: readonly AgentStrategy[]; #market: PaperMarket; #clock: () => number;
  #active = new Map<string, Active>(); #queue: Promise<unknown> = Promise.resolve(); #auto: boolean; #ready: () => boolean;
  #closing = false;
  constructor(root: string, strategies: readonly AgentStrategy[], market: PaperMarket, ready: () => boolean, clock = Date.now, auto = true) {
    this.#root = join(root, "paper"); this.#strategies = strategies; this.#market = market; this.#ready = ready; this.#clock = clock; this.#auto = auto;
  }
  #serial<T>(fn: () => Promise<T> | T): Promise<T> { const next = this.#queue.then(fn, fn); this.#queue = next.catch(() => {}); return next; }
  #dir(id: string) { if (!validId(id)) throw new Error("Invalid paper run ID"); return join(this.#root, id); }
  #strategy(id: string) { const s = this.#strategies.find(s => s.id === id); if (!s?.paperFactory) throw new Error("Strategy has no paper runner"); return s; }
  configure(input: PaperSetup) {
    const s = this.#strategy(input.strategyId);
    if (!validId(input.runId) || typeof input.includePremarket !== "boolean") throw new Error("Invalid paper setup");
    const { runId: _r, strategyId: _s, date, symbols, includePremarket, ...settings } = input;
    const config = s.preview({ ...settings, date, symbols, includePremarketLeadMinutes: includePremarket ? 2 : 0 });
    const configHash = createHash("sha256").update(JSON.stringify({ strategy: s.id, version: s.version, config })).digest("hex");
    try { const old = this.get(input.runId); if (old.configHash !== configHash) throw new Error("Run ID already has different settings"); return old; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    mkdirSync(this.#root, { recursive: true, mode: 0o700 }); mkdirSync(this.#dir(input.runId), { mode: 0o700 });
    const runtime = s.paperFactory!(config, this.#market, this.#clock);
    const record: PaperRecord = { runId: input.runId, strategyId: s.id, version: s.version, date: input.date, config, configHash, revision: 0,
      status: "configured", at: new Date(this.#clock()).toISOString(), checkpoint: runtime.checkpoint(), view: runtime.view(), mode: "paper", ordersSubmitted: 0,
      events: [{ type: "configured", data: { config, strategyVersion: s.version } }] };
    this.#persist(record); return record;
  }
  #persist(record: PaperRecord) { publish(join(this.#dir(record.runId), `${String(record.revision).padStart(8, "0")}.json`), record); }
  get(id: string): PaperRecord {
    const files = readdirSync(this.#dir(id)).filter(f => /^\d{8}\.json$/.test(f)).sort();
    if (!files.length) throw new Error("Incomplete paper run storage");
    const r = readJSON(join(this.#dir(id), files.at(-1)!)) as PaperRecord;
    if (r.runId !== id || r.mode !== "paper" || r.ordersSubmitted !== 0 || !Number.isInteger(r.revision) ||
      `${String(r.revision).padStart(8, "0")}.json` !== files.at(-1)) throw new Error("Invalid paper record");
    if (this.#active.has(id)) return { ...r, view: this.#active.get(id)!.runtime.view() };
    return r;
  }
  status(id: string) { const record = this.get(id);
    // A detached run's marks go stale on the run's own quote-age setting (5 s for strategies without one).
    const setting = (record.config as { maxQuoteAgeMs?: unknown } | null)?.maxQuoteAgeMs, staleMs = typeof setting === "number" ? setting : DEFAULT_MARK_STALE_MS;
    if (!this.#active.has(id) && record.view.positions.some(p => {
      const age = p.markAt ? this.#clock() - Date.parse(p.markAt) : NaN;
      return !Number.isFinite(age) || age < 0 || age > staleMs;
    })) {
      record.view = { ...record.view, unrealizedPnlCents: null, positions: record.view.positions.map(p => ({ ...p, markBid: null, markAt: null })) };
    }
    return { ...record, attached: this.#active.has(id),
    needsResume: record.status === "running" && !this.#active.has(id) && !this.#ended(record),
    needsSettlement: !this.#active.has(id) && record.status !== "completed" && record.view.positions.length > 0 && this.#ended(record),
    pnlEstimateOnly: true, feesExcluded: true }; }
  /** The run's session has closed. A date the calendar no longer covers reads as not ended rather than breaking listings. */
  #ended(record: PaperRecord) { try { return this.#clock() >= sessionTimes(record.date).close; } catch { return false; } }
  list() {
    try { return readdirSync(this.#root).filter(validId).filter(id => id !== "reservations").map(id => {
      const r = this.status(id); return { runId: id, strategyId: r.strategyId, date: r.date, status: r.status, attached: r.attached, needsResume: r.needsResume,
        needsSettlement: r.needsSettlement, positions: r.view.positions.length };
    }); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
  }
  events(id: string, after = -1, limit = 20) {
    if (!Number.isInteger(after) || after < -1 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid event page");
    const files = readdirSync(this.#dir(id)).filter(f => /^\d{8}\.json$/.test(f) && Number(f.slice(0,8)) > after).sort().slice(0,limit);
    return files.map(file => { const r = readJSON(join(this.#dir(id), file)) as PaperRecord; return { revision: r.revision, at: r.at, events: r.events }; });
  }
  #acquire(record: PaperRecord) {
    const path = join(this.#dir(record.runId), "owner.json");
    const guard = join(this.#dir(record.runId), "acquiring");
    // Serialize dead-owner recovery too: two rescuers must not unlink each other's new lock.
    // A crash during this tiny critical section leaves the guard for manual offline inspection.
    try { mkdirSync(guard, { mode: 0o700 }); } catch { throw new Error("Run ownership is being acquired or needs offline inspection"); }
    try {
    try { publish(path, { pid: process.pid }); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const old = readJSON(path);
      if (!Number.isInteger(old.pid) || old.pid < 1) throw new Error("Invalid owner record");
      try { process.kill(old.pid, 0); throw new Error("Another process owns this run"); }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err; }
      unlinkSync(path); publish(path, { pid: process.pid });
    }
    } finally { rmdirSync(guard); }
  }
  #release(id: string) { const active = this.#active.get(id); if (active?.timer) clearTimeout(active.timer); this.#active.delete(id); unlinkSync(join(this.#dir(id), "owner.json")); }
  start(id: string, resume = false) { return this.#serial(async () => {
    if (this.#closing) throw new Error("Server is shutting down");
    if (this.#active.has(id)) return this.status(id);
    const record = this.get(id), strategy = this.#strategy(record.strategyId), session = sessionTimes(record.date);
    if (strategy.version !== record.version) throw new Error("Strategy version changed; cannot resume");
    // Nothing trades after the close. A run stopped while holding contracts settles (no market data needed) instead of lingering.
    if (resume && this.#clock() >= session.close && record.status !== "completed" && record.view.positions.length) return this.#settle(record, strategy);
    if (!this.#ready()) throw new Error("Authorize required paper market-data tools first");
    if (this.#clock() >= session.close) throw new Error("Session expired; no automatic rollover");
    if (!resume && record.status !== "configured") throw new Error("Existing run requires explicit resume");
    if (!resume && this.#clock() >= session.open + 120000) throw new Error("Start before the first two-minute candle completes");
    if (resume && !record.view.positions.length) throw new Error("Recovery only manages existing paper positions; no new entries after a gap");
    mkdirSync(join(this.#root, "reservations"), { recursive: true, mode: 0o700 });
    const reservation = join(this.#root, "reservations", `${record.strategyId}-${record.date}.json`);
    try { publish(reservation, { runId: id }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST" || readJSON(reservation).runId !== id) throw new Error("Strategy already has a run for this date"); }
    this.#acquire(record);
    try {
      const runtime = strategy.paperFactory!(record.config, this.#market, this.#clock, resume ? record.checkpoint : undefined);
      const next = { ...record, status: "running" as const, revision: record.revision + 1, at: new Date(this.#clock()).toISOString(), checkpoint: runtime.checkpoint(),
        events: [{ type: resume ? "resumed_management_only" : "started", data: { mode: "paper" } }] };
      this.#persist(next); this.#active.set(id, { runtime, record: next }); this.#schedule(id); return this.status(id);
    } catch (e) { unlinkSync(join(this.#dir(id), "owner.json")); throw e; }
  }); }
  /** The strategy's own close step settles a detached run after its session: unsold contracts are written off. No market data. */
  async #settle(record: PaperRecord, strategy: AgentStrategy) {
    this.#acquire(record);
    try {
      const runtime = strategy.paperFactory!(record.config, this.#market, this.#clock, record.checkpoint);
      const events = await runtime.step(), view = runtime.view();
      if (!view.complete) throw new Error("Paper run could not be settled");
      this.#persist({ ...record, status: "completed", revision: record.revision + 1, at: new Date(this.#clock()).toISOString(),
        checkpoint: runtime.checkpoint(), view, events: [{ type: "settled_after_session", data: { previousStatus: record.status } }, ...events] });
    } finally { unlinkSync(join(this.#dir(record.runId), "owner.json")); }
    return this.status(record.runId);
  }
  #schedule(id: string) {
    if (!this.#auto) return; const active = this.#active.get(id); if (!active) return;
    active.timer = setTimeout(() => { void this.tick(id).catch(() => {}); }, active.runtime.pollMs ?? 1000);
  }
  tick(id: string) { return this.#serial(async () => {
    const active = this.#active.get(id); if (!active) throw new Error("Run is not attached");
    try {
      const events = await active.runtime.step(), view = active.runtime.view();
      if (events.length || view.complete) {
        const next: PaperRecord = { ...active.record, revision: active.record.revision + 1, status: view.complete ? "completed" : "running", at: new Date(this.#clock()).toISOString(),
          checkpoint: active.runtime.checkpoint(), view, events };
        this.#persist(next); active.record = next;
      }
      if (view.complete) this.#release(id); else this.#schedule(id);
      return this.status(id);
    } catch (error) {
      // Keep what the failed step already did: the runtime's own state (consistent at every await) and the events it produced,
      // so an entry confirmed before the failure is neither lost nor re-bought with recycled budget on resume.
      let kept = { checkpoint: active.record.checkpoint, view: active.record.view };
      try { kept = { checkpoint: active.runtime.checkpoint(), view: active.runtime.view() }; } catch { /* the last good record stands */ }
      const next: PaperRecord = { ...active.record, ...kept, revision: active.record.revision + 1, status: "error", at: new Date(this.#clock()).toISOString(),
        events: [...(error instanceof StepError ? error.events : []), { type: "run_halted", data: { reason: "data_or_storage_failure",
          detail: String((error as Error)?.message ?? error).slice(0, 200), noOrdersSubmitted: true } }] };
      try { this.#persist(next); } finally { this.#release(id); }
      throw new Error("Paper run halted; inspect status before explicit recovery");
    }
  }); }
  stop(id: string) { return this.#serial(() => {
    const active = this.#active.get(id); if (!active) return this.status(id);
    const next: PaperRecord = { ...active.record, revision: active.record.revision + 1, status: "stopped", at: new Date(this.#clock()).toISOString(),
      checkpoint: active.runtime.checkpoint(), view: active.runtime.view(), events: [{ type: "stopped", data: { paperPositionsRetained: true } }] };
    try { this.#persist(next); } finally { this.#release(id); } return this.status(id);
  }); }
  execute(id: string, command: PaperControl) { return this.#serial(async () => {
    const active = this.#active.get(id); if (!active) throw new Error("Run must be active for a position change");
    const events = await active.runtime.control(command);
    const next: PaperRecord = { ...active.record, revision: active.record.revision + 1, at: new Date(this.#clock()).toISOString(),
      checkpoint: active.runtime.checkpoint(), view: active.runtime.view(), events };
    try { this.#persist(next); active.record = next; } catch (e) { this.#release(id); throw e; }
    return { executed: events.some(e => e.type === "paper_sale"), events };
  }); }
  async close() {
    this.#closing = true;
    await this.#queue;
    const outcomes = await Promise.allSettled([...this.#active.keys()].map(id => this.stop(id)));
    if (outcomes.some(o => o.status === "rejected")) throw new Error("Paper monitoring stopped, but a final checkpoint could not be saved");
  }
  daily(date: string) {
    const records = this.list().filter(r => r.date === date).map(r => this.status(r.runId));
    return { date, mode: "paper", runs: records.length, realizedPnlCents: records.reduce((sum, r) => sum + r.view.realizedPnlCents, 0),
      unrealizedPnlCents: records.some(r => r.view.unrealizedPnlCents === null) ? null : records.reduce((sum, r) => sum + r.view.unrealizedPnlCents!, 0),
      feesExcluded: true, estimateOnly: true, ordersSubmitted: 0 };
  }
}
