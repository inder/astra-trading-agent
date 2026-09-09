import type { RobinhoodConnection } from "./broker-connection.ts";

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
export class RobinhoodMarketData {
  #connection: Pick<RobinhoodConnection, "read">;
  constructor(connection: Pick<RobinhoodConnection, "read">) { this.#connection = connection; }
  async quotes(symbols: string[]) {
    validateSymbols(symbols);
    return normalizeMarketQuotes(await this.#connection.read("get_equity_quotes", { symbols }), symbols);
  }
}
