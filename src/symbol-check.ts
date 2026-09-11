import { validateSymbols, type EquityMarketQuote } from "./market-data.ts";
import { preferredWeeklyExpiration, weeklyExpiryTarget } from "./orb-options.ts";

export interface SymbolSource {
  quotes(symbols: string[]): Promise<EquityMarketQuote[]>;
  /** Expiry dates listed on the stock's tradable option chains. */
  listedExpirations(symbol: string): Promise<string[]>;
}
export type SymbolProblem = "no_price" | "lookup_failed" | "no_options" | "no_qualifying_expiry" | "check_failed";
export const SYMBOL_PROBLEMS: Record<SymbolProblem, string> = {
  no_price: "Robinhood returned no price for this ticker; check the spelling.",
  lookup_failed: "No Robinhood price lookup succeeded, so Robinhood may be unavailable; check the spelling and try again.",
  no_options: "Robinhood lists no tradable standard options for this stock.",
  no_qualifying_expiry: "Options exist, but not the week-ending expiry the entry rule needs for this session.",
  check_failed: "The Robinhood read failed; try again.",
};

/** Before a plan is saved: does each stock have a price and the week-ending expiry the entry rule needs on the session
 *  date? Strikes and option prices are judged at entry, not here. One quote batch, then one chain read per stock, in order. */
export async function checkSymbols(source: SymbolSource, symbols: string[], date: string) {
  validateSymbols(symbols);
  const targetExpiration = weeklyExpiryTarget(date), quotes = new Map<string, EquityMarketQuote>();
  let answered = true;
  try { for (const q of await source.quotes(symbols)) quotes.set(q.symbol, q); }
  catch {
    // One unknown ticker fails the whole batch: ask one by one so each stock gets its own answer. When no lookup succeeds
    // at all, Robinhood being unavailable is the likelier cause, so no ticker is called misspelled.
    answered = false;
    if (symbols.length > 1) for (const symbol of symbols) {
      try { const [q] = await source.quotes([symbol]); answered = true; if (q) quotes.set(symbol, q); } catch { /* this ticker only */ }
    }
  }
  const results = [];
  for (const symbol of symbols) {
    const q = quotes.get(symbol), price = q?.price ?? null;
    let expiration: string | null = null, problem: SymbolProblem | null = null;
    if (price === null) problem = answered ? "no_price" : "lookup_failed";
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
