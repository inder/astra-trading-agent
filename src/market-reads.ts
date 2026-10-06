// What a paper run needs to read market data safely, written once for the watch-only strategies: which quotes count as
// trades, and how a flapping provider is journaled. The opening-range runtime keeps its own private copies of these
// (unchanged in this version); a later change can point it here.
import type { EquityMarketQuote } from "./market-data.ts";
import type { PaperEvent } from "./paper-runtime.ts";

/** An active regular-session trade, never after its own fetch (clock skew between the venue and this machine must not
 *  become an impossible observation), of any age. */
export function validTrade(q: EquityMarketQuote | undefined, now: number): q is EquityMarketQuote {
  if (!q || !q.regularSession || q.state !== "active" || !(Number.isFinite(q.price) && q.price! > 0) || !q.tradeAt) return false;
  const retrieved = Date.parse(q.retrievedAt), age = retrieved - Date.parse(q.tradeAt);
  return Number.isFinite(age) && age >= 0 && retrieved <= now;
}
/** A valid trade no older than `maxAgeMs` when it was fetched: the only kind that may price or vouch for anything. */
export const freshTrade = (q: EquityMarketQuote | undefined, now: number, maxAgeMs: number): q is EquityMarketQuote =>
  validTrade(q, now) && Date.parse(q.retrievedAt) - Date.parse(q.tradeAt!) <= maxAgeMs;

/** Outages of each kind of read. One failed read is only counted (in the heartbeat); a second in a row opens a journaled
 *  outage (`data_gap`), later closed by `data_restored`, so a flapping provider cannot write an event per tick. A code
 *  defect (TypeError/ReferenceError) is not an outage: it is rethrown so it halts the step with its message. */
export class ReadGaps<Source extends string> {
  #gaps = new Map<Source, number>(); #journaled = new Set<Source>(); #failures: Partial<Record<Source, number>> = {};
  /** One provider read, failures swallowed into the outage record; null when it failed. */
  async read<T>(source: Source, now: number, events: PaperEvent[], read: () => Promise<T>): Promise<T | null> {
    try { const value = await read(); this.succeeded(source, now, events); return value; }
    catch (error) { this.failed(source, now, events, error); return null; }
  }
  succeeded(source: Source, now: number, events: PaperEvent[]): void {
    const since = this.#gaps.get(source); if (since === undefined) return;
    this.#gaps.delete(source);
    if (this.#journaled.delete(source)) events.push({ type: "data_restored", data: { source, outageMs: now - since } });
  }
  failed(source: Source, now: number, events: PaperEvent[], error: unknown): void {
    if (error instanceof TypeError || error instanceof ReferenceError) throw error;
    this.#failures[source] = (this.#failures[source] ?? 0) + 1;
    const since = this.#gaps.get(source);
    if (since === undefined) this.#gaps.set(source, now);
    else if (!this.#journaled.has(source)) {
      this.#journaled.add(source);
      events.push({ type: "data_gap", data: { source, since: new Date(since).toISOString(), detail: String((error as Error)?.message ?? error).slice(0, 200) } });
    }
  }
  /** Read failures since the last call, for the heartbeat. */
  takeFailures(): Partial<Record<Source, number>> { const out = this.#failures; this.#failures = {}; return out; }
  /** When the oldest open outage began, or null. */
  since(): string | null { const t = Math.min(...this.#gaps.values()); return Number.isFinite(t) ? new Date(t).toISOString() : null; }
}
