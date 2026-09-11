import { EntrySkip, preferredWeeklyExpiration, type OrbCallContract } from "./orb-options.ts";
import type { CallQuote } from "./orb-options.ts";

export interface OrbOptionSource {
  equityCallChains(symbol: string): Promise<unknown>;
  datedCallInstruments(chainId: string, expirations: readonly string[], cursor?: string): Promise<unknown>;
  optionQuotes(ids: readonly string[]): Promise<unknown>;
}
export function parseAvailableOrbCallQuotes(raw: unknown, ids: readonly string[], retrievedAt: string): CallQuote[] {
  const rows = (raw as any)?.data?.results;
  if (!Array.isArray(rows)) throw new Error("Missing option quote batch");
  const result: CallQuote[] = rows.map((r: any) => ({ id: r?.quote?.instrument_id, bid: Number(r?.quote?.bid_price),
    // Robinhood may send sizes as strings; an uncoerced "20" would fail every integer check and block every entry.
    ask: Number(r?.quote?.ask_price), askSize: Number(r?.quote?.ask_size), updatedAt: r?.quote?.updated_at, retrievedAt }));
  if (new Set(result.map(x => x.id)).size !== result.length || result.some(x => !ids.includes(x.id)))
    throw new Error("Duplicate or foreign option quote");
  return result;
}
const uuid = (s: unknown): s is string => typeof s === "string" && /^[a-f0-9-]{36}$/.test(s);
/** Standard 100-share option chains on the stock itself that can open positions. */
export function eligibleChains(raw: any, symbol: string): any[] {
  if (!Array.isArray(raw?.data?.chains) || raw.data.next) throw new Error("Incomplete option chains");
  return raw.data.chains.filter((x: any) => x && x.symbol === symbol && x.can_open_position === true && uuid(x.id) &&
    Number(x.trade_value_multiplier) === 100 && (x.cash_component == null || Number(x.cash_component) === 0) && Array.isArray(x.expiration_dates) &&
    Array.isArray(x.underlying_instruments) && x.underlying_instruments.length === 1 && x.underlying_instruments.every((u: any) =>
      u && typeof u.instrument === "string" && u.instrument.length && (u.symbol === "" || u.symbol === symbol)));
}
export async function loadOrbContracts(source: OrbOptionSource, symbol: string, date: string): Promise<{ expiration: string; contracts: OrbCallContract[] }> {
  const chains = eligibleChains(await source.equityCallChains(symbol), symbol);
  const expiration = preferredWeeklyExpiration(chains.flatMap((x: any) => x.expiration_dates), date);
  if (!expiration) throw new EntrySkip("no_qualifying_expiry");
  const contracts: OrbCallContract[] = [];
  for (const chain of chains.filter((x: any) => x.expiration_dates.includes(expiration))) {
    let cursor: string | undefined; const seen = new Set<string>();
    for (let page = 0; ; page++) {
      if (page >= 30) throw new Error("Option pagination limit reached");
      const data: any = await source.datedCallInstruments(chain.id, [expiration], cursor);
      if (!Array.isArray(data?.data?.instruments)) throw new Error("Option instruments unavailable");
      for (const i of data.data.instruments) {
        const t = i?.min_ticks;
        if (i?.chain_id === chain.id && i.chain_symbol === symbol && i.expiration_date === expiration && i.type === "call" && i.state === "active" &&
          i.tradability === "tradable" && i.underlying_type === "equity" && Number(i.trade_value_multiplier) === 100 && uuid(i.id) && Number(i.strike_price) > 0 &&
          Number(t?.below_tick) > 0 && Number(t?.above_tick) > 0 && Number(t?.cutoff_price) > 0 && typeof i.sellout_datetime === "string")
          contracts.push({ id: i.id, symbol, expiration, strike: Number(i.strike_price), multiplier: 100,
            tickBelow: Number(t.below_tick), tickAbove: Number(t.above_tick), tickCutoff: Number(t.cutoff_price), selloutAt: i.sellout_datetime });
      }
      if (!data.data.next) break;
      cursor = new URL(data.data.next).searchParams.get("cursor") ?? undefined;
      if (!cursor || seen.has(cursor)) throw new Error("Invalid/repeated option cursor"); seen.add(cursor);
    }
  }
  if (!contracts.length || new Set(contracts.map(x => x.id)).size !== contracts.length) throw new Error("Missing/duplicate option contracts");
  return { expiration, contracts };
}
