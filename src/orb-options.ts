import { isTradingDay } from "./daily-history.ts";
import { timestamp } from "./validation.ts";
export interface CallQuote { id: string; bid: number; ask: number; askSize: number; updatedAt: string; retrievedAt: string }

export interface OrbOptionsConfig {
  date: string; symbols: string[]; openingRangeMinutes: 2; stopBufferFraction: number;
  budgetCentsPerPosition: number; minimumContracts: number; preferredContracts: number;
  maximumPositions: number; trimGainFraction: number; maximumTrimSteps: number;
  feeReserveCentsPerContract: number; maxOptionSpreadFraction: number;
  maxQuoteAgeMs: number; maxObservationGapMs: number; pollMs: number;
  includePremarketLeadMinutes: 0 | 2; balanceBarMinutes: 2; balanceMinimumBars: number;
  balanceMaximumBars: number; balanceMaximumWidthFraction: number;
  balanceBreakoutCloseLocation: number;
}
export function parseOrbOptionsConfig(raw: unknown): OrbOptionsConfig {
  const c = raw as OrbOptionsConfig;
  const keys = ["date", "symbols", "openingRangeMinutes", "stopBufferFraction", "budgetCentsPerPosition",
    "minimumContracts", "preferredContracts", "maximumPositions", "trimGainFraction", "maximumTrimSteps",
    "feeReserveCentsPerContract", "maxOptionSpreadFraction", "maxQuoteAgeMs", "maxObservationGapMs", "pollMs",
    "includePremarketLeadMinutes", "balanceBarMinutes", "balanceMinimumBars", "balanceMaximumBars",
    "balanceMaximumWidthFraction", "balanceBreakoutCloseLocation"];
  if (!c || Object.keys(c).some(k => !keys.includes(k)) || !isTradingDay(c.date) || !Array.isArray(c.symbols) ||
    c.symbols.length < 1 || c.symbols.length > 20 || new Set(c.symbols).size !== c.symbols.length ||
    c.symbols.some(s => typeof s !== "string" || !/^[A-Z][A-Z0-9.-]{0,9}$/.test(s)) || c.openingRangeMinutes !== 2 ||
    c.stopBufferFraction !== .001 || c.budgetCentsPerPosition !== 200000 || c.minimumContracts !== 2 ||
    c.preferredContracts !== 4 || c.maximumPositions !== 2 || c.trimGainFraction !== .05 || c.maximumTrimSteps !== 4 ||
    !Number.isSafeInteger(c.feeReserveCentsPerContract) || c.feeReserveCentsPerContract < 1 || c.feeReserveCentsPerContract > 1000 ||
    !(c.maxOptionSpreadFraction > 0 && c.maxOptionSpreadFraction <= .2) || !Number.isSafeInteger(c.maxQuoteAgeMs) || c.maxQuoteAgeMs < 1000 ||
    !Number.isSafeInteger(c.maxObservationGapMs) || c.maxObservationGapMs < 1000 || !Number.isSafeInteger(c.pollMs) || c.pollMs < 250 || c.pollMs > 30000 ||
    ![0, 2].includes(c.includePremarketLeadMinutes) || c.balanceBarMinutes !== 2 || !Number.isSafeInteger(c.balanceMinimumBars) ||
    c.balanceMinimumBars < 3 || c.balanceMinimumBars > 15 || !Number.isSafeInteger(c.balanceMaximumBars) ||
    c.balanceMaximumBars < c.balanceMinimumBars + 1 || c.balanceMaximumBars > 30 ||
    !(c.balanceMaximumWidthFraction >= .002 && c.balanceMaximumWidthFraction <= .05) ||
    !(c.balanceBreakoutCloseLocation >= .5 && c.balanceBreakoutCloseLocation <= 1))
    throw new Error("Invalid opening-range options configuration");
  return structuredClone(c);
}

export interface OpeningRange { high: number; low: number; startMs: number; endMs: number }
export type OrbSetup = "opening_range" | "opening_balance";
export interface SetupRange extends OpeningRange { setup: OrbSetup }
export function parseOpeningRange(raw: unknown, symbol: string, startMs: number, minutes = 2, leadMinutes = 0): OpeningRange {
  const results = (raw as any)?.data?.results;
  const matches = Array.isArray(results) ? results.filter((r: any) => r?.symbol === symbol) : [];
  if (matches.length !== 1 || matches[0]?.interval !== "minute" || !["regular", "extended"].includes(matches[0]?.bounds) ||
    (leadMinutes > 0 && matches[0]?.bounds !== "extended") || !Array.isArray(matches[0]?.bars))
    throw new Error("Opening-range bars unavailable");
  const result = matches[0];
  if (!Number.isSafeInteger(minutes) || minutes < 1 || !Number.isSafeInteger(leadMinutes) || leadMinutes < 0) throw new Error("Invalid opening-range duration");
  const first = startMs - leadMinutes * 60000;
  const expected = Array.from({ length: minutes + leadMinutes }, (_, i) => first + i * 60000);
  const bars = new Map<number, any>();
  for (const bar of result.bars) {
    const at = timestamp(bar?.begins_at);
    if (!expected.includes(at)) continue;
    const allowedSession = at < startMs ? ["pre", "premarket"] : ["reg"];
    if (bars.has(at) || bar.interpolated === true || (bar.session !== undefined && !allowedSession.includes(bar.session))) throw new Error("Invalid opening-range bars");
    bars.set(at, bar);
  }
  if (!expected.every(t => bars.has(t))) throw new Error("Incomplete opening range");
  const highs = expected.map(t => Number(bars.get(t).high_price)), lows = expected.map(t => Number(bars.get(t).low_price));
  if (![...highs, ...lows].every(v => Number.isFinite(v) && v > 0) || highs.some((h, i) => h < lows[i]!)) throw new Error("Invalid opening-range prices");
  return { high: Math.max(...highs), low: Math.min(...lows), startMs: first, endMs: startMs + minutes * 60000 };
}
export interface ReplayResult { symbol: string; range: OpeningRange; outcome: "qualified" | "disqualified" | "ambiguous" | "no_event"; eventAt: string | null; eventPrice: number | null }
export function replayOpeningRange(raw: unknown, symbol: string, startMs: number, leadMinutes = 0): ReplayResult {
  const range = parseOpeningRange(raw, symbol, startMs, 2, leadMinutes);
  const rows = ((raw as any).data.results as any[]).find(r => r?.symbol === symbol).bars as any[];
  for (const b of rows) {
    const at = timestamp(b?.begins_at); if (at < range.endMs || b?.interpolated === true) continue;
    const high = Number(b.high_price), low = Number(b.low_price);
    if (!(high > 0 && low > 0 && high >= low)) throw new Error("Invalid replay bar");
    const up = high > range.high, down = low < range.low;
    if (up && down) return { symbol, range, outcome: "ambiguous", eventAt: b.begins_at, eventPrice: null };
    if (down) return { symbol, range, outcome: "disqualified", eventAt: b.begins_at, eventPrice: low };
    if (up) {
      const open = Number(b.open_price);
      return { symbol, range, outcome: "qualified", eventAt: b.begins_at, eventPrice: Number.isFinite(open) && open > 0 ? Math.max(range.high, open) : range.high };
    }
  }
  return { symbol, range, outcome: "no_event", eventAt: null, eventPrice: null };
}

export interface TwoMinuteBar { beginsAt: number; endsAt: number; open: number; high: number; low: number; close: number; volume: number }
export function twoMinuteBars(raw: unknown, symbol: string, startMs: number): TwoMinuteBar[] {
  const results = (raw as any)?.data?.results;
  const matches = Array.isArray(results) ? results.filter((r: any) => r?.symbol === symbol) : [];
  if (matches.length !== 1 || matches[0]?.interval !== "minute" || !["regular", "extended"].includes(matches[0]?.bounds) || !Array.isArray(matches[0]?.bars))
    throw new Error("Opening-balance bars unavailable");
  const source = new Map<number, any>();
  for (const bar of matches[0].bars) {
    const at = timestamp(bar?.begins_at);
    if (at < startMs || (at - startMs) % 60000 !== 0) continue;
    if (source.has(at) || bar.interpolated === true || (bar.session !== undefined && bar.session !== "reg")) throw new Error("Invalid opening-balance bars");
    source.set(at, bar);
  }
  const answer: TwoMinuteBar[] = [];
  for (let at = startMs; ; at += 120000) {
    const a = source.get(at), b = source.get(at + 60000);
    if (!a || !b) break;
    const open = Number(a.open_price), high = Math.max(Number(a.high_price), Number(b.high_price)),
      low = Math.min(Number(a.low_price), Number(b.low_price)), close = Number(b.close_price), volume = Number(a.volume) + Number(b.volume);
    if (![open, high, low, close, volume].every(Number.isFinite) || open <= 0 || low <= 0 || high < low || close <= 0 || volume < 0)
      throw new Error("Invalid opening-balance prices");
    answer.push({ beginsAt: at, endsAt: at + 120000, open, high, low, close, volume });
  }
  return answer;
}

export interface BalanceReplayResult {
  symbol: string; setup: "opening_balance"; range: OpeningRange | null;
  outcome: "forming" | "qualified" | "disqualified" | "no_event";
  eventAt: string | null; eventPrice: number | null; barsInBalance: number;
}
export function replayOpeningBalance(raw: unknown, symbol: string, startMs: number, c: OrbOptionsConfig): BalanceReplayResult {
  const bars = twoMinuteBars(raw, symbol, startMs);
  if (!bars.length) return { symbol, setup: "opening_balance", range: null, outcome: "forming", eventAt: null, eventPrice: null, barsInBalance: 0 };
  const first = bars[0]!;
  let range: OpeningRange = { high: Math.max(first.open, first.close), low: Math.min(first.open, first.close), startMs, endMs: first.endsAt };
  const width = (high: number, low: number) => (high - low) / ((high + low) / 2);
  if (width(range.high, range.low) > c.balanceMaximumWidthFraction)
    return { symbol, setup: "opening_balance", range, outcome: "disqualified", eventAt: new Date(first.endsAt).toISOString(), eventPrice: null, barsInBalance: 1 };
  for (let i = 1; i < bars.length && i < c.balanceMaximumBars; i++) {
    const bar = bars[i]!, closeLocation = (bar.close - bar.low) / Math.max(Number.EPSILON, bar.high - bar.low);
    if (i >= c.balanceMinimumBars && bar.close > range.high && bar.low >= range.low && closeLocation >= c.balanceBreakoutCloseLocation) {
      range = { ...range, endMs: bar.beginsAt };
      return { symbol, setup: "opening_balance", range, outcome: "qualified", eventAt: new Date(bar.endsAt).toISOString(), eventPrice: bar.close, barsInBalance: i };
    }
    const high = Math.max(range.high, bar.high), low = Math.min(range.low, bar.low);
    range = { ...range, high, low, endMs: bar.endsAt };
    if (width(high, low) > c.balanceMaximumWidthFraction)
      return { symbol, setup: "opening_balance", range, outcome: "disqualified", eventAt: new Date(bar.endsAt).toISOString(), eventPrice: null, barsInBalance: i + 1 };
  }
  if (bars.length >= c.balanceMaximumBars)
    return { symbol, setup: "opening_balance", range, outcome: "no_event", eventAt: new Date(range.endMs).toISOString(), eventPrice: null, barsInBalance: c.balanceMaximumBars };
  return { symbol, setup: "opening_balance", range, outcome: "forming", eventAt: null, eventPrice: null, barsInBalance: bars.length };
}

export interface TrimReplay { step: number; threshold: number; firstHitAt: string | null }
export interface DualReplayResult {
  symbol: string; selectedSetup: OrbSetup | null; entryAt: string | null; entryPrice: number | null;
  openingRange: ReplayResult; openingBalance: BalanceReplayResult; protectiveStop: number | null;
  stoppedAt: string | null; ambiguousExitAt: string | null; trims: TrimReplay[];
}
export function replayOrbSetups(raw: unknown, symbol: string, startMs: number, c: OrbOptionsConfig): DualReplayResult {
  const openingRange = replayOpeningRange(raw, symbol, startMs, c.includePremarketLeadMinutes);
  const openingBalance = replayOpeningBalance(raw, symbol, startMs, c);
  const candidates = [
    ...(openingRange.outcome === "qualified" && openingRange.eventAt && openingRange.eventPrice ? [{ setup: "opening_range" as const, at: openingRange.eventAt, price: openingRange.eventPrice }] : []),
    ...(openingBalance.outcome === "qualified" && openingBalance.eventAt && openingBalance.eventPrice ? [{ setup: "opening_balance" as const, at: openingBalance.eventAt, price: openingBalance.eventPrice }] : []),
  ].sort((a, b) => timestamp(a.at) - timestamp(b.at) || a.setup.localeCompare(b.setup));
  const selected = candidates[0] ?? null;
  const selectedRange = selected?.setup === "opening_range" ? openingRange.range : selected?.setup === "opening_balance" ? openingBalance.range : null;
  const protectiveStop = selectedRange ? selectedRange.low * (1 - c.stopBufferFraction) : null;
  const trims: TrimReplay[] = Array.from({ length: c.maximumTrimSteps }, (_, i) => ({ step: i + 1,
    threshold: selected ? selected.price * (1 + c.trimGainFraction * (i + 1)) : 0, firstHitAt: null }));
  let stoppedAt: string | null = null, ambiguousExitAt: string | null = null;
  if (selected) {
    const result = ((raw as any).data.results as any[]).find(r => r?.symbol === symbol);
    for (const bar of result?.bars ?? []) {
      const at = timestamp(bar?.begins_at), high = Number(bar?.high_price), low = Number(bar?.low_price);
      const beforeLifecycle = selected.setup === "opening_range" ? at <= timestamp(selected.at) : at < timestamp(selected.at);
      if (beforeLifecycle || !Number.isFinite(high) || !Number.isFinite(low)) continue;
      const stopHit = protectiveStop !== null && low < protectiveStop;
      const newlyHit = trims.filter(t => !t.firstHitAt && high >= t.threshold);
      if (stopHit && newlyHit.length) { ambiguousExitAt = bar.begins_at; break; }
      if (stopHit) { stoppedAt = bar.begins_at; break; }
      for (const trim of newlyHit) trim.firstHitAt = bar.begins_at;
    }
  }
  return { symbol, selectedSetup: selected?.setup ?? null, entryAt: selected?.at ?? null, entryPrice: selected?.price ?? null,
    openingRange, openingBalance, protectiveStop, stoppedAt, ambiguousExitAt, trims };
}

export interface OrbCallContract {
  id: string; symbol: string; expiration: string; strike: number; multiplier: 100;
  tickBelow: number; tickAbove: number; tickCutoff: number; selloutAt: string;
}
export interface OrbCallSelection {
  contract: OrbCallContract; quantity: number; limitPrice: number;
  premiumCents: number; feeReserveCents: number; committedCents: number;
  relativeSpread: number; quoteUpdatedAt: string;
}
export function nearestPreferredExpiration(expirations: readonly string[], date: string): string | null {
  const active = [...new Set(expirations)].filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= date).sort();
  return active.find(d => new Date(d + "T00:00:00Z").getUTCDay() === 5) ?? active[0] ?? null;
}
export function selectOrbCall(contracts: readonly OrbCallContract[], quotes: readonly CallQuote[], symbol: string,
  expiration: string, stockPrice: number, c: OrbOptionsConfig, now: number): OrbCallSelection | null {
  if (!(stockPrice > 0) || new Set(contracts.map(x => x.id)).size !== contracts.length) return null;
  const choices: OrbCallSelection[] = [];
  for (const k of contracts) {
    if (k.symbol !== symbol || k.expiration !== expiration || k.multiplier !== 100 || !(k.strike > 0) ||
      !Number.isFinite(timestamp(k.selloutAt)) || timestamp(k.selloutAt) <= now) continue;
    const found = quotes.filter(q => q.id === k.id); if (found.length !== 1) continue;
    const q = found[0]!;
    if (!(q.bid > 0 && q.ask >= q.bid && Number.isFinite(q.ask)) || !Number.isSafeInteger(q.askSize) || q.askSize < c.minimumContracts ||
      ![q.updatedAt, q.retrievedAt].every(t => Number.isFinite(timestamp(t)) && timestamp(t) <= now && now - timestamp(t) <= c.maxQuoteAgeMs) || timestamp(q.updatedAt) > timestamp(q.retrievedAt)) continue;
    const relativeSpread = (q.ask - q.bid) / ((q.ask + q.bid) / 2); if (relativeSpread > c.maxOptionSpreadFraction) continue;
    const belowTickCents = Math.round(k.tickBelow * 100), aboveTickCents = Math.round(k.tickAbove * 100), cutoffCents = Math.round(k.tickCutoff * 100);
    if (![belowTickCents, aboveTickCents, cutoffCents].every(v => Number.isSafeInteger(v) && v > 0) ||
      Math.abs(k.tickBelow * 100 - belowTickCents) > 1e-7 || Math.abs(k.tickAbove * 100 - aboveTickCents) > 1e-7) continue;
    let limitCents = Math.ceil((q.ask * 100 - 1e-8) / (q.ask * 100 < cutoffCents ? belowTickCents : aboveTickCents)) * (q.ask * 100 < cutoffCents ? belowTickCents : aboveTickCents);
    if (limitCents >= cutoffCents) limitCents = Math.ceil(limitCents / aboveTickCents) * aboveTickCents;
    const unit = limitCents * 100 + c.feeReserveCentsPerContract;
    const affordable = Math.min(c.preferredContracts, q.askSize, Math.floor(c.budgetCentsPerPosition / unit));
    if (affordable < c.minimumContracts) continue;
    choices.push({ contract: k, quantity: affordable, limitPrice: limitCents / 100, premiumCents: limitCents * 100 * affordable,
      feeReserveCents: c.feeReserveCentsPerContract * affordable, committedCents: unit * affordable, relativeSpread, quoteUpdatedAt: q.updatedAt });
  }
  // Prefer four, then three, then two contracts; within that, nearest-to-money, tighter spread, then stable ID.
  choices.sort((a, b) => b.quantity - a.quantity || Math.abs(a.contract.strike - stockPrice) - Math.abs(b.contract.strike - stockPrice) ||
    a.relativeSpread - b.relativeSpread || a.contract.id.localeCompare(b.contract.id));
  return choices[0] ?? null;
}

type Status = "forming" | "watching" | "disqualified" | "entry_pending" | "open" | "closed" | "skipped";
type RouteStatus = "forming" | "watching" | "qualified" | "disqualified" | "no_event";
interface Position { contractId: string; originalQuantity: number; remainingQuantity: number; entryStockPrice: number; trimStepsFilled: number }
interface SymbolState {
  status: Status; range: SetupRange | null; strictRange: OpeningRange | null;
  strictStatus: RouteStatus; balanceStatus: RouteStatus; lastTradeMs: number | null;
  lastObservationMs: number | null; position: Position | null; pendingSale: number;
}
export type OrbIntent =
  | { kind: "enter_calls"; setup: OrbSetup; symbol: string; stockPrice: number; at: number; range: SetupRange }
  | { kind: "sell_to_close"; reason: "protective_stop" | "profit_trim" | "user_trim" | "user_close"; symbol: string; contractId: string; quantity: number; stockPrice: number; at: number };
export interface OrbSnapshot { symbols: Record<string, SymbolState>; reservedPositions: number }
export class OrbOptionsEngine {
  readonly config: OrbOptionsConfig; #state: Map<string, SymbolState>; #reserved = 0;
  constructor(config: OrbOptionsConfig) {
    this.config = parseOrbOptionsConfig(config);
    this.#state = new Map(this.config.symbols.map(s => [s, { status: "forming", range: null, strictRange: null,
      strictStatus: "forming" as const, balanceStatus: "forming" as const, lastTradeMs: null, lastObservationMs: null, position: null, pendingSale: 0 }]));
  }
  setRange(symbol: string, range: OpeningRange): void {
    const s = this.#need(symbol);
    const duration = (this.config.openingRangeMinutes + this.config.includePremarketLeadMinutes) * 60000;
    if (s.status !== "forming" || range.endMs - range.startMs !== duration || !(range.high >= range.low && range.low > 0)) throw new Error("Invalid/finalized opening range");
    s.strictRange = structuredClone(range); s.range = { ...structuredClone(range), setup: "opening_range" };
    s.strictStatus = "watching"; s.balanceStatus = "watching"; s.status = "watching";
  }
  failRange(symbol: string): void {
    const s = this.#need(symbol); if (s.status !== "forming") throw new Error("Opening range already finalized");
    s.status = "watching"; s.strictStatus = "disqualified"; s.balanceStatus = "watching";
  }
  observe(symbol: string, stockPrice: number, at: number, observedAt = at): OrbIntent[] {
    const s = this.#need(symbol); if (!(stockPrice > 0) || !Number.isFinite(at) || !Number.isFinite(observedAt) || at > observedAt) throw new Error("Invalid trade");
    if (s.lastObservationMs !== null && observedAt - s.lastObservationMs > this.config.maxObservationGapMs && s.status === "watching") {
      s.status = "disqualified"; s.strictStatus = "disqualified"; s.balanceStatus = "disqualified";
    }
    if (s.lastObservationMs !== null && observedAt < s.lastObservationMs) return [];
    s.lastObservationMs = observedAt;
    if (s.lastTradeMs !== null && at - s.lastTradeMs > this.config.maxObservationGapMs && s.status === "watching") {
      s.status = "disqualified"; s.strictStatus = "disqualified"; s.balanceStatus = "disqualified";
    }
    if (s.lastTradeMs !== null && at <= s.lastTradeMs) return [];
    s.lastTradeMs = at;
    if (s.status === "watching" && s.strictStatus === "watching" && s.strictRange && at >= s.strictRange.endMs) {
      if (stockPrice < s.strictRange.low) s.strictStatus = "disqualified";
      else if (stockPrice > s.strictRange.high) {
        s.strictStatus = "qualified";
        return this.#reserve(symbol, stockPrice, at, { ...structuredClone(s.strictRange), setup: "opening_range" });
      }
      if (s.strictStatus === "disqualified" && ["disqualified", "no_event"].includes(s.balanceStatus)) s.status = "disqualified";
    }
    if (s.status !== "open" || !s.position || !s.range || s.pendingSale) return [];
    const p = s.position, stop = s.range.low * (1 - this.config.stopBufferFraction);
    if (stockPrice < stop) {
      s.pendingSale = p.remainingQuantity;
      return [{ kind: "sell_to_close", reason: "protective_stop", symbol, contractId: p.contractId, quantity: p.remainingQuantity, stockPrice, at }];
    }
    const levelsReached = Math.min(this.config.maximumTrimSteps, Math.floor((stockPrice / p.entryStockPrice - 1 + 1e-12) / this.config.trimGainFraction));
    const targetSold = Math.min(p.originalQuantity, levelsReached); const alreadySold = p.originalQuantity - p.remainingQuantity;
    const quantity = targetSold - alreadySold;
    if (quantity > 0) {
      s.pendingSale = quantity;
      return [{ kind: "sell_to_close", reason: "profit_trim", symbol, contractId: p.contractId, quantity, stockPrice, at }];
    }
    return [];
  }
  offerOpeningBalance(result: BalanceReplayResult): OrbIntent[] {
    const s = this.#need(result.symbol);
    if (result.outcome === "forming") return [];
    if (s.balanceStatus === "qualified" || ["disqualified", "no_event"].includes(s.balanceStatus)) return [];
    s.balanceStatus = result.outcome;
    if (result.outcome === "qualified") {
      if (!result.range || !result.eventAt || !(result.eventPrice && result.eventPrice > result.range.high)) throw new Error("Invalid opening-balance qualification");
      return this.#reserve(result.symbol, result.eventPrice, timestamp(result.eventAt), { ...structuredClone(result.range), setup: "opening_balance" });
    }
    if (s.status === "watching" && s.strictStatus === "disqualified") s.status = "disqualified";
    return [];
  }
  confirmEntry(symbol: string, contractId: string, quantity: number, entryStockPrice: number): void {
    const s = this.#need(symbol);
    if (s.status !== "entry_pending" || !/^[a-f0-9-]{36}$/.test(contractId) || !Number.isInteger(quantity) || quantity < this.config.minimumContracts || quantity > this.config.preferredContracts || !(entryStockPrice > 0)) throw new Error("Invalid entry confirmation");
    s.position = { contractId, originalQuantity: quantity, remainingQuantity: quantity, entryStockPrice, trimStepsFilled: 0 }; s.status = "open";
  }
  failEntry(symbol: string): void {
    const s = this.#need(symbol); if (s.status !== "entry_pending") throw new Error("No pending entry");
    s.status = "skipped"; this.#reserved--;
  }
  confirmSale(symbol: string, quantity: number): void {
    const s = this.#need(symbol), p = s.position;
    if (s.status !== "open" || !p || quantity !== s.pendingSale || quantity > p.remainingQuantity) throw new Error("Invalid sale confirmation");
    p.remainingQuantity -= quantity; p.trimStepsFilled += quantity; s.pendingSale = 0;
    if (!p.remainingQuantity) s.status = "closed";
  }
  failSale(symbol: string): void { const s = this.#need(symbol); if (!s.pendingSale) throw new Error("No pending sale"); s.pendingSale = 0; }
  requestPositionSale(symbol: string, reason: "user_trim" | "user_close", quantity: number, expectedRemainingQuantity: number,
    stockPrice: number, at: number): OrbIntent[] {
    const s = this.#need(symbol), p = s.position;
    if (s.status !== "open" || !p || s.pendingSale || !Number.isSafeInteger(quantity) || quantity <= 0 ||
      !Number.isSafeInteger(expectedRemainingQuantity) || expectedRemainingQuantity !== p.remainingQuantity || quantity > p.remainingQuantity ||
      (reason === "user_close" && quantity !== p.remainingQuantity) || !(stockPrice > 0) || !Number.isFinite(at)) return [];
    s.pendingSale = quantity;
    return [{ kind: "sell_to_close", reason, symbol, contractId: p.contractId, quantity, stockPrice, at }];
  }
  snapshot(): OrbSnapshot { return { symbols: Object.fromEntries([...this.#state].map(([k, v]) => [k, structuredClone(v)])), reservedPositions: this.#reserved }; }
  #reserve(symbol: string, stockPrice: number, at: number, range: SetupRange): OrbIntent[] {
    const s = this.#need(symbol);
    if (s.status !== "watching") return [];
    if (this.#reserved >= this.config.maximumPositions) { s.status = "skipped"; return []; }
    s.status = "entry_pending"; s.range = structuredClone(range); this.#reserved++;
    return [{ kind: "enter_calls", setup: range.setup, symbol, stockPrice, at, range: structuredClone(range) }];
  }
  #need(symbol: string): SymbolState { const s = this.#state.get(symbol); if (!s) throw new Error("Symbol outside run universe"); return s; }
}
