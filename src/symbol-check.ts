import { validateSymbols, type EquityMarketQuote } from "./market-data.ts";
import { preferredWeeklyExpiration, weeklyExpiryTarget } from "./orb-options.ts";

export interface SymbolSource {
  quotes(symbols: string[]): Promise<EquityMarketQuote[]>;
  /** Expiry dates listed on the stock's tradable option chains. */
  listedExpirations(symbol: string): Promise<string[]>;
}
export type SymbolProblem = "no_price" | "no_options" | "no_qualifying_expiry" | "check_failed";
export const SYMBOL_PROBLEMS: Record<SymbolProblem, string> = {
  no_price: "Robinhood returned no price for this ticker; check the spelling.",
  no_options: "Robinhood lists no tradable standard options for this stock.",
  no_qualifying_expiry: "Options exist, but not the week-ending expiry the entry rule needs for this session.",
  check_failed: "The Robinhood read failed; try again.",
};

/** Before a plan is saved: does each stock have a price and the week-ending expiry the entry rule needs on the session
 *  date? Strikes and option prices are judged at entry, not here. One quote batch, then one chain read per stock, in order. */
export async function checkSymbols(source: SymbolSource, symbols: string[], date: string) {
  validateSymbols(symbols);
  const targetExpiration = weeklyExpiryTarget(date), quotes = new Map<string, EquityMarketQuote>();
  try { for (const q of await source.quotes(symbols)) quotes.set(q.symbol, q); }
  catch {
    // One unknown ticker fails the whole batch: ask one by one so each stock gets its own answer.
    for (const symbol of symbols) { try { const [q] = await source.quotes([symbol]); if (q) quotes.set(symbol, q); } catch { /* reported as no_price */ } }
  }
  const results = [];
  for (const symbol of symbols) {
    const q = quotes.get(symbol), price = q?.price ?? null;
    let expiration: string | null = null, problem: SymbolProblem | null = null;
    if (price === null) problem = "no_price";
    else {
      try {
        const listed = await source.listedExpirations(symbol);
        expiration = preferredWeeklyExpiration(listed, date);
        problem = !listed.length ? "no_options" : expiration ? null : "no_qualifying_expiry";
      } catch { problem = "check_failed"; }
    }
    // A price is the last trade, which is old outside market hours: fresh says whether it is current.
    results.push({ symbol, usable: problem === null, problem, price, lastTradeAt: q?.tradeAt ?? null, fresh: q?.fresh ?? false, expiration });
  }
  return { date, targetExpiration, symbols: results, ordersSubmitted: 0 };
}
