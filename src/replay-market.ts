import { preferredWeeklyExpiration, type CallQuote, type OrbCallContract } from "./orb-options.ts";
import { addDays, isWeekEnder, sessionTimes } from "./daily-history.ts";
import type { EquityMarketQuote } from "./market-data.ts";
import type { OptionCatalog, PaperMarket } from "./paper-market.ts";

// A replay market: REAL minute bars drive the stock side; the option side is MODELED (Black-Scholes at a stated
// volatility) because historical option quotes are not available. Nothing here contains market data.

export interface MinuteBar { begins_at: string; open_price: string; high_price: string; low_price: string; close_price: string; session?: string; interpolated?: boolean }
export interface BarsFile { data: { results: { symbol: string; interval: string; bounds: string; bars: MinuteBar[] }[] } }

const round4 = (x: number) => Math.round(x * 1e4) / 1e4;
/** The modeled path inside one minute: open, then the low, then the high, then the close (at 0, 20, 40 and 59 s), linear
 *  in between. The adverse extreme always comes first, so a replay can understate a winner but never invent an entry,
 *  or a target ahead of a stop, that the minute bar does not support. */
export function pathPrice(bar: MinuteBar, secondOfMinute: number): number {
  const anchors: [number, number][] = [[0, +bar.open_price], [20, +bar.low_price], [40, +bar.high_price], [59, +bar.close_price]];
  const s = Math.min(59, Math.max(0, secondOfMinute));
  for (let i = 1; i < anchors.length; i++) {
    const [s0, p0] = anchors[i - 1]!, [s1, p1] = anchors[i]!;
    if (s === s1) return p1;
    if (s < s1) return round4(p0 + (p1 - p0) * (s - s0) / (s1 - s0));
  }
  return +bar.close_price;
}
/** Standard normal distribution function (Abramowitz and Stegun 26.2.17; absolute error below 7.5e-8). */
export function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x)), d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const tail = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - tail : tail;
}
/** Black-Scholes value of a call with no dividends and a zero rate: the MODELED option price. */
export function callValue(stock: number, strike: number, volatility: number, years: number): number {
  if (years <= 0 || volatility <= 0) return Math.max(0, stock - strike);
  const v = volatility * Math.sqrt(years), d1 = (Math.log(stock / strike) + v * v / 2) / v;
  return stock * normalCdf(d1) - strike * normalCdf(d1 - v);
}
/** Assumed listing grid (not verified against any exchange): finer strikes for cheaper stocks. */
export function strikeIncrement(price: number): number { return price < 25 ? 0.5 : price < 200 ? 1 : price < 500 ? 2.5 : 5; }
const YEAR_MS = 365 * 86400000;
const tick = (price: number) => (price < 3 ? 0.01 : 0.05);

export interface ReplayMarketOptions {
  regular: BarsFile; extended?: BarsFile; clock: () => number;
  /** Assumed annual volatility per symbol for the MODELED option prices. */
  volatility: Record<string, number>;
  /** How long after its minute ends a bar is published (the opening-range retry path). */
  barLagMs?: number;
  /** Modeled bid-ask spread as a fraction of the option's value (at least one tick each side). */
  spreadFraction?: number;
  askSize?: number;
}
export class ReplayMarket implements PaperMarket {
  #o: Required<Omit<ReplayMarketOptions, "extended">> & { extended?: BarsFile };
  #bars = new Map<string, Map<number, MinuteBar>>();
  #contracts = new Map<string, OrbCallContract>();
  constructor(options: ReplayMarketOptions) {
    this.#o = { barLagMs: 0, spreadFraction: 0.04, askSize: 50, ...options };
    for (const r of options.regular.data.results)
      this.#bars.set(r.symbol, new Map(r.bars.map(b => [Date.parse(b.begins_at), b])));
  }
  /** The modeled trade at this second (every regular-session second has one), or null outside the session. */
  price(symbol: string, at: number): number | null {
    const second = Math.floor(at / 1000) * 1000, minute = Math.floor(second / 60000) * 60000;
    const bar = this.#bars.get(symbol)?.get(minute);
    return bar ? pathPrice(bar, (second - minute) / 1000) : null;
  }
  async quotes(symbols: string[]): Promise<EquityMarketQuote[]> {
    const now = this.#o.clock(), second = Math.floor(now / 1000) * 1000, retrievedAt = new Date(now).toISOString();
    return symbols.map(symbol => {
      const price = this.price(symbol, now);
      return price === null
        ? { symbol, price: null, tradeAt: null, retrievedAt, ageMs: null, fresh: false, regularSession: false, state: "unavailable", bid: null, ask: null }
        : { symbol, price, tradeAt: new Date(second).toISOString(), retrievedAt, ageMs: now - second, fresh: true, regularSession: true, state: "active", bid: null, ask: null };
    });
  }
  async bars(symbols: string[], start: number, end: number, extended: boolean): Promise<unknown> {
    const file = extended ? this.#o.extended : this.#o.regular;
    if (!file) throw new Error("Replay has no extended-hours bars");
    const published = this.#o.clock() - this.#o.barLagMs;
    return { data: { results: symbols.map(symbol => ({ symbol, interval: "minute", bounds: extended ? "extended" : "regular",
      bars: (file.data.results.find(r => r.symbol === symbol)?.bars ?? []).filter(b => {
        const at = Date.parse(b.begins_at); return at >= start && at < end && at + 60000 <= published;
      }) })) } };
  }
  async contracts(symbol: string, date: string): Promise<OptionCatalog> {
    const listing = Array.from({ length: 21 }, (_, i) => addDays(date, i)).filter(isWeekEnder);
    const expiration = preferredWeeklyExpiration(listing, date);
    if (!expiration) throw new Error("No modeled expiry");
    const first = [...(this.#bars.get(symbol)?.values() ?? [])].sort((a, b) => Date.parse(a.begins_at) - Date.parse(b.begins_at))[0];
    if (!first) throw new Error(`No bars for ${symbol}`);
    const open = +first.open_price, step = strikeIncrement(open), symbolIndex = [...this.#bars.keys()].indexOf(symbol) + 1;
    const selloutAt = new Date(sessionTimes(expiration).close - 30 * 60000).toISOString();
    const contracts: OrbCallContract[] = [];
    for (let k = Math.ceil(open * 0.7 / step), n = 0; k * step <= open * 1.3; k++, n++) {
      const contract: OrbCallContract = { id: `${symbolIndex.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`,
        symbol, expiration, strike: round4(k * step), multiplier: 100, tickBelow: 0.01, tickAbove: 0.05, tickCutoff: 3, selloutAt };
      contracts.push(contract); this.#contracts.set(contract.id, contract);
    }
    return { expiration, contracts };
  }
  async optionQuotes(ids: string[]): Promise<CallQuote[]> {
    // The same request rules as the real provider: 1 to 20 distinct, well-formed ids, all of them known.
    if (!ids.length || ids.length > 20 || new Set(ids).size !== ids.length || ids.some(id => !/^[a-f0-9-]{36}$/.test(id) || !this.#contracts.has(id)))
      throw new Error("Invalid option IDs");
    const now = this.#o.clock(), at = new Date(now).toISOString();
    return ids.flatMap(id => {
      const k = this.#contracts.get(id), stock = k && this.price(k.symbol, now);
      if (!k || stock == null) return [];
      const value = callValue(stock, k.strike, this.#o.volatility[k.symbol] ?? 0.9, (sessionTimes(k.expiration).close - now) / YEAR_MS);
      const half = Math.max(tick(value), value * this.#o.spreadFraction / 2);
      const bid = Math.max(0.01, Math.floor((value - half) / tick(value - half) + 1e-9) * tick(value - half));
      const ask = Math.ceil((value + half) / tick(value + half) - 1e-9) * tick(value + half);
      return [{ id, bid: round4(bid), ask: round4(ask), askSize: this.#o.askSize, updatedAt: at, retrievedAt: at }];
    });
  }
}
