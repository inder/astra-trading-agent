import type { RobinhoodConnection } from "./broker-connection.ts";
import { timestamp } from "./validation.ts";
import type { DailyBars } from "./levels.ts";

export interface EquityMarketQuote {
  symbol: string; price: number | null; tradeAt: string | null; retrievedAt: string;
  ageMs: number | null; fresh: boolean; regularSession: boolean; state: string; bid: number | null; ask: number | null;
}
export function validateSymbols(symbols: readonly string[]) {
  if (!Array.isArray(symbols) || symbols.length < 1 || symbols.length > 20 || new Set(symbols).size !== symbols.length ||
    symbols.some(s => typeof s !== "string" || !/^[A-Z][A-Z0-9.-]{0,9}$/.test(s))) throw new Error("Invalid ticker list");
}
export function normalizeMarketQuotes(raw: any, symbols: string[], now = Date.now()): EquityMarketQuote[] {
  validateSymbols(symbols);
  const rows = raw?.data?.results;
  if (!Array.isArray(rows) || rows.length !== symbols.length || new Set(rows.map(r => r?.quote?.symbol)).size !== symbols.length ||
    rows.some(r => !symbols.includes(r?.quote?.symbol))) throw new Error("Incomplete or mismatched quote batch");
  const positive = (v: unknown) => typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null;
  const time = (v: unknown) => typeof v === "string" && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(v) ? Date.parse(v) : NaN;
  return rows.map(row => {
    const q = row.quote;
    const regularTime = time(q.venue_last_trade_time), nonRegularTime = time(q.venue_last_non_reg_trade_time);
    const regularSession = !(Number.isFinite(nonRegularTime) && (!Number.isFinite(regularTime) || nonRegularTime > regularTime));
    const at = regularSession ? regularTime : nonRegularTime;
    const price = positive(regularSession ? q.last_trade_price : q.last_non_reg_trade_price);
    const ageMs = Number.isFinite(at) ? now - at : null;
    const active = q.state === "active" && q.has_traded === true;
    const bidAge = now - time(q.venue_bid_time), askAge = now - time(q.venue_ask_time);
    const bid = bidAge >= 0 && bidAge <= 5000 ? positive(q.bid_price) : null;
    const ask = askAge >= 0 && askAge <= 5000 ? positive(q.ask_price) : null;
    return { symbol: q.symbol, price: active ? price : null, tradeAt: Number.isFinite(at) ? new Date(at).toISOString() : null,
      retrievedAt: new Date(now).toISOString(), ageMs, fresh: active && price !== null && ageMs !== null && ageMs >= 0 && ageMs <= 5000,
      regularSession, state: active ? "active" : "unavailable", bid: active && bid && ask && bid <= ask ? bid : null,
      ask: active && bid && ask && bid <= ask ? ask : null };
  });
}
/** Split-adjusted, so a 4-for-1 does not read as a crash. Dividends are left in, matching the charts levels came from. */
export const DAILY_ADJUSTMENT = "split";
/** The provider answered, but its bars are not a usable price history. Distinct from a read that failed, so a user
 *  is never told a stock has no history when it was the connection that broke. */
export class DailyBarsError extends Error { name = "DailyBarsError"; }
/** Bars up to, but not including, `from`. Today's bar is still forming while the market is open: its high, low and
 *  close are all provisional, and a provisional bar must never be measured, cached or counted as a session. */
export function sessionsBefore(bars: DailyBars, from: string): DailyBars {
  const cut = bars.time.findIndex(t => t >= from);
  if (cut < 0) return bars;
  return { time: bars.time.slice(0, cut), open: bars.open.slice(0, cut), high: bars.high.slice(0, cut),
    low: bars.low.slice(0, cut), close: bars.close.slice(0, cut) };
}
/** Bars left out, by where they sat. Position is the whole point: padding before the first real session and the
 *  placeholder for the session still being finalized are ordinary and are described elsewhere — by `sinceListing`
 *  and by the as-of date. A gap punched through the MIDDLE of a history is not ordinary, and neither is a bar whose
 *  prices cannot be a session. Only those two are worth interrupting a reader for. */
export interface DroppedBars {
  /** Padding before the first real session, and the placeholder for the session still being finalized. */
  leading: number; trailing: number;
  /** Sessions missing from the middle of a history, whatever the reason. The only count worth interrupting for. */
  interior: number;
}

/** Regular-session daily bars for one stock, oldest first, as the levels engine takes them.
 *
 *  A bar that is not a real session is DROPPED, not thrown on. Robinhood pads the window it is asked for: every day
 *  before an instrument existed comes back `interpolated: true` at a flat price — HOOD's history begins with 218 bars
 *  at its $38 IPO price, RBRK's with 907 at $32 — and the current day arrives the same way until it is finalized,
 *  which after the close is every symbol. Refusing the whole history on sight of one of these threw away six years of
 *  real bars because of a synthetic one, and it took out every recently-listed holding, then every holding at all
 *  once the day's placeholder appeared (2026-09-16).
 *
 *  Dropping is safe for the reason the refusal existed: a synthetic bar still never becomes a level. The engine works
 *  by bar index and a missing session is already invisible to it. What must not happen is dropping SILENTLY, so the
 *  count comes back with the bars and is reported beside the levels.
 *
 *  Structure is still refused outright. Out-of-order bars are not a bad bar but a bad series, and nothing here can
 *  say which of two conflicting orders is right. */
export function normalizeDailyBars(raw: unknown, symbol: string): { bars: DailyBars; dropped: DroppedBars } {
  const results = (raw as any)?.data?.results;
  const matches = Array.isArray(results) ? results.filter((r: any) => r?.symbol === symbol) : [];
  if (matches.length !== 1 || matches[0]?.interval !== "day" || !Array.isArray(matches[0]?.bars)) throw new DailyBarsError("Daily bars unavailable");
  // Classified in place first, because where a dropped bar sat decides whether it is worth mentioning at all.
  type Verdict = { keep: true; at: string; prices: number[] } | { keep: false; why: "interpolated" | "unusable" };
  const seen = new Set<string>();
  const verdicts: Verdict[] = matches[0].bars.map((bar: any): Verdict => {
    const at = typeof bar?.begins_at === "string" ? bar.begins_at.slice(0, 10) : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(at) || !Number.isFinite(timestamp(bar.begins_at))) return { keep: false, why: "unusable" };
    if (bar.interpolated === true) return { keep: false, why: "interpolated" };
    if (seen.has(at)) return { keep: false, why: "unusable" };
    const prices = [bar.open_price, bar.high_price, bar.low_price, bar.close_price].map(Number);
    // A zero low is what a corrupt bar looks like: SGOV's 2022-02-02 came back l=0 between two ordinary sessions.
    if (!prices.every(v => Number.isFinite(v) && v > 0) || prices[1]! < prices[2]!) return { keep: false, why: "unusable" };
    seen.add(at);
    return { keep: true, at, prices };
  });
  // Nothing real came back. Said plainly, rather than handed on as an empty history for something else to explain.
  // Checked before counting, so the counts below always describe a history that exists.
  const first = verdicts.findIndex(v => v.keep);
  if (first < 0) throw new DailyBarsError("No real daily bars in the range");
  const last = verdicts.findLastIndex(v => v.keep);
  const bars: DailyBars = { time: [], open: [], high: [], low: [], close: [] };
  // Position decides the bucket, not the reason. A corrupt bar at the end is the day still being finalized, exactly
  // like an interpolated one; a corrupt bar in the middle is a hole, exactly like a missing one. Counting by reason
  // instead would have warned "N days inside this history" about a bar at the edge, and would have put that line on
  // every holding every evening the moment a placeholder arrived without the interpolated flag.
  const dropped: DroppedBars = { leading: 0, trailing: 0, interior: 0 };
  verdicts.forEach((v, i) => {
    if (v.keep) {
      bars.time.push(v.at); bars.open.push(v.prices[0]!); bars.high.push(v.prices[1]!);
      bars.low.push(v.prices[2]!); bars.close.push(v.prices[3]!);
    } else if (i < first) dropped.leading++;
    else if (i > last) dropped.trailing++;
    else dropped.interior++;
  });
  if (bars.time.some((t, i) => i > 0 && t <= bars.time[i - 1]!)) throw new DailyBarsError("Daily bars are out of order");
  return { bars, dropped };
}
export class RobinhoodMarketData {
  #connection: Pick<RobinhoodConnection, "read">;
  constructor(connection: Pick<RobinhoodConnection, "read">) { this.#connection = connection; }
  async quotes(symbols: string[]) {
    validateSymbols(symbols);
    return normalizeMarketQuotes(await this.#connection.read("get_equity_quotes", { symbols }), symbols);
  }
  /** Daily bars for one stock between two dates, split-adjusted. One read per call; the caller caches. */
  async dailyBars(symbol: string, startMs: number, endMs: number): Promise<{ bars: DailyBars; dropped: DroppedBars }> {
    validateSymbols([symbol]);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) throw new Error("Invalid history window");
    const raw = await this.#connection.read("get_equity_historicals", { symbols: [symbol], interval: "day", bounds: "regular",
      adjustment_type: DAILY_ADJUSTMENT, start_time: new Date(startMs).toISOString(), end_time: new Date(endMs).toISOString() });
    return normalizeDailyBars(raw, symbol);
  }
}
