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
/** Regular-session daily bars for one stock, oldest first, as the levels engine takes them. Prices that are missing,
 *  unparsable, interpolated or out of order are refused rather than quietly turned into a level. */
export function normalizeDailyBars(raw: unknown, symbol: string): DailyBars {
  const results = (raw as any)?.data?.results;
  const matches = Array.isArray(results) ? results.filter((r: any) => r?.symbol === symbol) : [];
  if (matches.length !== 1 || matches[0]?.interval !== "day" || !Array.isArray(matches[0]?.bars)) throw new Error("Daily bars unavailable");
  const out: DailyBars = { time: [], open: [], high: [], low: [], close: [] };
  const seen = new Set<string>();
  for (const bar of matches[0].bars) {
    const at = typeof bar?.begins_at === "string" ? bar.begins_at.slice(0, 10) : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(at) || !Number.isFinite(timestamp(bar.begins_at))) throw new Error("Invalid daily bar date");
    if (bar.interpolated === true) throw new Error("Invalid daily bars");
    if (seen.has(at)) throw new Error("Duplicate daily bar");
    seen.add(at);
    const prices = [bar.open_price, bar.high_price, bar.low_price, bar.close_price].map(Number);
    if (!prices.every(v => Number.isFinite(v) && v > 0) || prices[1]! < prices[2]!) throw new Error("Invalid daily bar prices");
    out.time.push(at); out.open.push(prices[0]!); out.high.push(prices[1]!); out.low.push(prices[2]!); out.close.push(prices[3]!);
  }
  if (out.time.some((t, i) => i > 0 && t <= out.time[i - 1]!)) throw new Error("Daily bars are out of order");
  return out;
}
export class RobinhoodMarketData {
  #connection: Pick<RobinhoodConnection, "read">;
  constructor(connection: Pick<RobinhoodConnection, "read">) { this.#connection = connection; }
  async quotes(symbols: string[]) {
    validateSymbols(symbols);
    return normalizeMarketQuotes(await this.#connection.read("get_equity_quotes", { symbols }), symbols);
  }
  /** Daily bars for one stock between two dates, split-adjusted. One read per call; the caller caches. */
  async dailyBars(symbol: string, startMs: number, endMs: number): Promise<DailyBars> {
    validateSymbols([symbol]);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) throw new Error("Invalid history window");
    const raw = await this.#connection.read("get_equity_historicals", { symbols: [symbol], interval: "day", bounds: "regular",
      adjustment_type: DAILY_ADJUSTMENT, start_time: new Date(startMs).toISOString(), end_time: new Date(endMs).toISOString() });
    return normalizeDailyBars(raw, symbol);
  }
}
