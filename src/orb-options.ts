import { addDays, isTradingDay, isWeekEnder, tradingSessionsBetween } from "./daily-history.ts";
import { timestamp } from "./validation.ts";
export interface CallQuote { id: string; bid: number; ask: number; askSize: number; updatedAt: string; retrievedAt: string }

export interface OrbOptionsConfig {
  date: string; symbols: string[]; openingRangeMinutes: 2; stopBufferFraction: number;
  budgetCentsPerPosition: number; budgetCentsPerDay: number; minimumContracts: number; maximumContractsPerTrade: number | null;
  maximumPositions: number; trimGainFraction: number; maximumTrimSteps: number;
  feeReserveCentsPerContract: number; maxOptionSpreadFraction: number;
  maxQuoteAgeMs: number; maxObservationGapMs: number; pollMs: number;
  includePremarketLeadMinutes: 0 | 2; entryWindowMinutes: number;
}
/** User-tunable minutes after the 9:30 open during which new entries may start (founder default 90 = 11:00 ET). */
export const ENTRY_WINDOW_MINUTES = { default: 90, min: 5, max: 390 } as const;
/** User settings: founder defaults and validated ranges, shared by the MCP schema and config parsing. Premium is treated
 *  as money lost, so the caps are the risk control. maximumContractsPerTrade null = bounded only by the displayed ask size. */
export const SETTINGS = {
  budgetCentsPerPosition: { default: 200_000, min: 10_000, max: 5_000_000 },
  budgetCentsPerDay: { default: 400_000, min: 10_000, max: 10_000_000 },
  minimumContracts: { default: 4, min: 1, max: 100 },
  maximumContractsPerTrade: { default: null, min: 1, max: 1_000_000 },
  maximumPositions: { default: 2, min: 1, max: 10 },
  maxOptionSpreadFraction: { default: 0.2, min: 0.01, max: 0.5 },
  feeReserveCentsPerContract: { default: 100, min: 0, max: 1000 },
} as const;
const inRange = (v: unknown, r: { min: number; max: number }, integer = true) =>
  typeof v === "number" && (integer ? Number.isSafeInteger(v) : Number.isFinite(v)) && v >= r.min && v <= r.max;
export function parseOrbOptionsConfig(raw: unknown): OrbOptionsConfig {
  const c = raw as OrbOptionsConfig;
  const keys = ["date", "symbols", "openingRangeMinutes", "stopBufferFraction", "budgetCentsPerPosition",
    "budgetCentsPerDay", "minimumContracts", "maximumContractsPerTrade", "maximumPositions", "trimGainFraction", "maximumTrimSteps",
    "feeReserveCentsPerContract", "maxOptionSpreadFraction", "maxQuoteAgeMs", "maxObservationGapMs", "pollMs",
    "includePremarketLeadMinutes", "entryWindowMinutes"];
  if (!c || Object.keys(c).some(k => !keys.includes(k)) || !isTradingDay(c.date) || !Array.isArray(c.symbols) ||
    c.symbols.length < 1 || c.symbols.length > 20 || new Set(c.symbols).size !== c.symbols.length ||
    c.symbols.some(s => typeof s !== "string" || !/^[A-Z][A-Z0-9.-]{0,9}$/.test(s)) || c.openingRangeMinutes !== 2 ||
    c.stopBufferFraction !== .001 || c.trimGainFraction !== .05 || c.maximumTrimSteps !== 4 ||
    !inRange(c.budgetCentsPerPosition, SETTINGS.budgetCentsPerPosition) || !inRange(c.budgetCentsPerDay, SETTINGS.budgetCentsPerDay) ||
    c.budgetCentsPerDay < c.budgetCentsPerPosition || !inRange(c.minimumContracts, SETTINGS.minimumContracts) ||
    !(c.maximumContractsPerTrade === null || (inRange(c.maximumContractsPerTrade, SETTINGS.maximumContractsPerTrade) && c.maximumContractsPerTrade >= c.minimumContracts)) ||
    !inRange(c.maximumPositions, SETTINGS.maximumPositions) || !inRange(c.feeReserveCentsPerContract, SETTINGS.feeReserveCentsPerContract) ||
    !inRange(c.maxOptionSpreadFraction, SETTINGS.maxOptionSpreadFraction, false) ||
    // The cheapest possible contract is $0.01 (100 cents) plus the fee reserve: a minimum that can never fit trades nothing all day.
    c.minimumContracts * (100 + c.feeReserveCentsPerContract) > c.budgetCentsPerPosition ||
    !Number.isSafeInteger(c.maxQuoteAgeMs) || c.maxQuoteAgeMs < 1000 ||
    !Number.isSafeInteger(c.maxObservationGapMs) || c.maxObservationGapMs < 1000 || !Number.isSafeInteger(c.pollMs) || c.pollMs < 250 || c.pollMs > 30000 ||
    ![0, 2].includes(c.includePremarketLeadMinutes) ||
    !Number.isSafeInteger(c.entryWindowMinutes) || c.entryWindowMinutes < ENTRY_WINDOW_MINUTES.min || c.entryWindowMinutes > ENTRY_WINDOW_MINUTES.max)
    throw new Error("Invalid opening-range options configuration");
  return structuredClone(c);
}

export interface OpeningRange { high: number; low: number; startMs: number; endMs: number }
export type OrbSetup = "opening_range";
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

export interface OrbCallContract {
  id: string; symbol: string; expiration: string; strike: number; multiplier: 100;
  tickBelow: number; tickAbove: number; tickCutoff: number; selloutAt: string;
}
export interface OrbCallSelection {
  contract: OrbCallContract; quantity: number; limitPrice: number;
  premiumCents: number; feeReserveCents: number; committedCents: number;
  relativeSpread: number; quoteUpdatedAt: string;
}
/** A deliberate no-entry decision (a rule said no), as opposed to missing or stale data. */
export class EntrySkip extends Error {
  readonly reason: string;
  constructor(reason: string) { super(reason); this.reason = reason; }
}
export const MIN_EXPIRY_SESSIONS = 3;
/** Founder rule (2026-09-10): the first week-ending expiry with at least 3 trading sessions counting the
 *  trade day — Mon–Wed trades use that Friday, Thu/Fri the next; holiday weeks count real sessions (the
 *  Wednesday before Thanksgiving gets the following Friday). The target must be LISTED; otherwise null,
 *  because a later expiry is a different trade. Mon/Wed daily expiries are never chosen. */
export function preferredWeeklyExpiration(listed: readonly string[], date: string): string | null {
  if (!isTradingDay(date)) throw new Error("Unsupported trade date");
  for (let d = date, i = 0; i < 21; d = addDays(d, 1), i++)
    if (isWeekEnder(d) && tradingSessionsBetween(date, d) >= MIN_EXPIRY_SESSIONS) return listed.includes(d) ? d : null;
  throw new Error("No week-ending expiry within three weeks");
}
/** Founder rule: the strike nearest the stock price (ITM or OTM) where at least minimumContracts fit under the cap, then
 *  fill up to the cap at that strike, bounded by the displayed ask size (and maximumContractsPerTrade if set). capCents is
 *  the caller's min(per-trade cap, per-day cap - already committed), so the runtime and the sample share one budget rule. */
export function selectOrbCall(contracts: readonly OrbCallContract[], quotes: readonly CallQuote[], symbol: string,
  expiration: string, stockPrice: number, c: OrbOptionsConfig, now: number, capCents = c.budgetCentsPerPosition): OrbCallSelection | null {
  if (!(stockPrice > 0) || !Number.isSafeInteger(capCents) || capCents <= 0 || new Set(contracts.map(x => x.id)).size !== contracts.length) return null;
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
    const quantity = Math.min(q.askSize, Math.floor(capCents / unit), c.maximumContractsPerTrade ?? Number.MAX_SAFE_INTEGER);
    if (quantity < c.minimumContracts) continue;
    choices.push({ contract: k, quantity, limitPrice: limitCents / 100, premiumCents: limitCents * 100 * quantity,
      feeReserveCents: c.feeReserveCentsPerContract * quantity, committedCents: unit * quantity, relativeSpread, quoteUpdatedAt: q.updatedAt });
  }
  // Nearest to the money first; equidistant strikes fall back to the tighter spread, then the stable id.
  choices.sort((a, b) => Math.abs(a.contract.strike - stockPrice) - Math.abs(b.contract.strike - stockPrice) ||
    a.relativeSpread - b.relativeSpread || a.contract.id.localeCompare(b.contract.id));
  return choices[0] ?? null;
}

type Status = "forming" | "watching" | "disqualified" | "entry_pending" | "open" | "closed" | "skipped";
/** Why a symbol stopped watching without entering; surfaced in views and the journal. */
export type EndReason = "opening_low_failed" | "range_unavailable" | "late_first_quote" | "observation_gap" | "entry_window_closed" | "resumed_management_only";
const END_REASONS: readonly EndReason[] = ["opening_low_failed", "range_unavailable", "late_first_quote", "observation_gap", "entry_window_closed", "resumed_management_only"];
interface Position { contractId: string; originalQuantity: number; remainingQuantity: number; entryStockPrice: number; trimStepsFilled: number }
interface SymbolState {
  status: Status; range: SetupRange | null; openingRange: OpeningRange | null; endReason: EndReason | null;
  lastTradeMs: number | null; lastObservationMs: number | null; position: Position | null; pendingSale: number;
}
export type OrbIntent =
  | { kind: "enter_calls"; setup: OrbSetup; symbol: string; stockPrice: number; at: number; range: SetupRange }
  | { kind: "sell_to_close"; reason: "protective_stop" | "profit_trim" | "user_trim" | "user_close" | "session_close"; symbol: string; contractId: string; quantity: number; stockPrice: number; at: number };
export interface OrbSnapshot { symbols: Record<string, SymbolState>; reservedPositions: number }
export class OrbOptionsEngine {
  readonly config: OrbOptionsConfig; #state: Map<string, SymbolState>; #reserved = 0;
  constructor(config: OrbOptionsConfig) {
    this.config = parseOrbOptionsConfig(config);
    this.#state = new Map(this.config.symbols.map(s => [s, { status: "forming", range: null, openingRange: null, endReason: null,
      lastTradeMs: null, lastObservationMs: null, position: null, pendingSale: 0 }]));
  }
  setRange(symbol: string, range: OpeningRange): void {
    const s = this.#need(symbol);
    const duration = (this.config.openingRangeMinutes + this.config.includePremarketLeadMinutes) * 60000;
    if (s.status !== "forming" || range.endMs - range.startMs !== duration || !(range.high >= range.low && range.low > 0)) throw new Error("Invalid/finalized opening range");
    s.openingRange = structuredClone(range); s.range = { ...structuredClone(range), setup: "opening_range" }; s.status = "watching";
  }
  /** No usable opening range: the symbol has no route to an entry today. */
  failRange(symbol: string, reason: "range_unavailable" | "late_first_quote" = "range_unavailable"): void {
    const s = this.#need(symbol); if (s.status !== "forming") throw new Error("Opening range already finalized");
    s.status = "disqualified"; s.endReason = reason;
  }
  /** End watching for the day (never affects an entry or position already in progress). */
  disqualify(symbol: string, reason: EndReason): void {
    const s = this.#need(symbol);
    if (s.status === "watching") { s.status = "disqualified"; s.endReason = reason; }
  }
  /** New entries stop entryWindowMinutes after the open; open positions keep being managed. */
  entryDeadline(): number | null {
    const r = [...this.#state.values()].find(s => s.openingRange)?.openingRange;
    return r ? r.endMs - this.config.openingRangeMinutes * 60000 + this.config.entryWindowMinutes * 60000 : null;
  }
  closeEntryWindow(now: number): string[] {
    const deadline = this.entryDeadline(); if (deadline === null || now < deadline) return [];
    const closed = [...this.#state].filter(([, s]) => s.status === "watching").map(([symbol]) => symbol);
    for (const symbol of closed) this.disqualify(symbol, "entry_window_closed");
    return closed;
  }
  observe(symbol: string, stockPrice: number, at: number, observedAt = at): OrbIntent[] {
    const s = this.#need(symbol); if (!(stockPrice > 0) || !Number.isFinite(at) || !Number.isFinite(observedAt) || at > observedAt) throw new Error("Invalid trade");
    if (s.lastObservationMs !== null && observedAt - s.lastObservationMs > this.config.maxObservationGapMs) this.disqualify(symbol, "observation_gap");
    if (s.lastObservationMs !== null && observedAt < s.lastObservationMs) return [];
    s.lastObservationMs = observedAt;
    if (s.lastTradeMs !== null && at - s.lastTradeMs > this.config.maxObservationGapMs) this.disqualify(symbol, "observation_gap");
    if (s.lastTradeMs !== null && at <= s.lastTradeMs) return [];
    s.lastTradeMs = at;
    if (s.status === "watching" && s.openingRange && at >= s.openingRange.endMs) {
      // The founder's rule: a trade beneath the opening-range low ends the day for this symbol, even if it later rallies.
      // Checked at the polled-trade resolution; a dip that reverses between polls can be missed (documented limitation).
      if (at >= this.entryDeadline()!) this.disqualify(symbol, "entry_window_closed");
      else if (stockPrice < s.openingRange.low) this.disqualify(symbol, "opening_low_failed");
      else if (stockPrice > s.openingRange.high) return this.#reserve(symbol, stockPrice, at, { ...structuredClone(s.openingRange), setup: "opening_range" });
    }
    if (s.status !== "open" || !s.position || !s.range || s.pendingSale) return [];
    const p = s.position, stop = s.range.low * (1 - this.config.stopBufferFraction);
    if (stockPrice < stop) {
      s.pendingSale = p.remainingQuantity;
      return [{ kind: "sell_to_close", reason: "protective_stop", symbol, contractId: p.contractId, quantity: p.remainingQuantity, stockPrice, at }];
    }
    const levelsReached = Math.min(this.config.maximumTrimSteps, Math.floor((stockPrice / p.entryStockPrice - 1 + 1e-12) / this.config.trimGainFraction));
    // One contract per level up to four contracts; larger positions scale proportionally so the fourth level exits fully.
    const targetSold = Math.min(p.originalQuantity, Math.max(levelsReached, Math.ceil(p.originalQuantity * levelsReached / this.config.maximumTrimSteps)));
    const alreadySold = p.originalQuantity - p.remainingQuantity;
    const quantity = targetSold - alreadySold;
    if (quantity > 0) {
      s.pendingSale = quantity;
      return [{ kind: "sell_to_close", reason: "profit_trim", symbol, contractId: p.contractId, quantity, stockPrice, at }];
    }
    return [];
  }
  confirmEntry(symbol: string, contractId: string, quantity: number, entryStockPrice: number): void {
    const s = this.#need(symbol);
    if (s.status !== "entry_pending" || !/^[a-f0-9-]{36}$/.test(contractId) || !Number.isInteger(quantity) || quantity < this.config.minimumContracts ||
      (this.config.maximumContractsPerTrade !== null && quantity > this.config.maximumContractsPerTrade) || !(entryStockPrice > 0)) throw new Error("Invalid entry confirmation");
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
  requestPositionSale(symbol: string, reason: "user_trim" | "user_close" | "protective_stop" | "session_close", quantity: number, expectedRemainingQuantity: number,
    stockPrice: number, at: number): OrbIntent[] {
    const s = this.#need(symbol), p = s.position;
    if (s.status !== "open" || !p || s.pendingSale || !Number.isSafeInteger(quantity) || quantity <= 0 ||
      !Number.isSafeInteger(expectedRemainingQuantity) || expectedRemainingQuantity !== p.remainingQuantity || quantity > p.remainingQuantity ||
      (reason !== "user_trim" && quantity !== p.remainingQuantity) || !(stockPrice > 0) || !Number.isFinite(at)) return [];
    s.pendingSale = quantity;
    return [{ kind: "sell_to_close", reason, symbol, contractId: p.contractId, quantity, stockPrice, at }];
  }
  snapshot(): OrbSnapshot { return { symbols: Object.fromEntries([...this.#state].map(([k, v]) => [k, structuredClone(v)])), reservedPositions: this.#reserved }; }
  restore(raw: OrbSnapshot): void {
    if (!raw || !raw.symbols || Object.keys(raw.symbols).length !== this.config.symbols.length ||
      !Number.isInteger(raw.reservedPositions) || raw.reservedPositions < 0 || raw.reservedPositions > this.config.maximumPositions)
      throw new Error("Invalid engine checkpoint");
    let reserved = 0;
    for (const symbol of this.config.symbols) {
      const s = raw.symbols[symbol];
      if (!s || !["forming", "watching", "disqualified", "open", "closed", "skipped"].includes(s.status) || s.pendingSale !== 0)
        throw new Error("Checkpoint contains incomplete transaction");
      if (!(s.endReason === null || END_REASONS.includes(s.endReason)) || (s.status === "disqualified") !== (s.endReason !== null) ||
        (s.status === "watching" && !s.openingRange)) throw new Error("Invalid saved symbol state");
      if (["open", "closed"].includes(s.status)) {
        const p = s.position; reserved++;
        if (!p || !s.range || !(s.range.high >= s.range.low && s.range.low > 0) ||
          !/^[a-f0-9-]{36}$/.test(p.contractId) || !Number.isSafeInteger(p.originalQuantity) || p.originalQuantity < 1 ||
          !Number.isInteger(p.remainingQuantity) || p.remainingQuantity < 0 || p.remainingQuantity > p.originalQuantity ||
          (s.status === "closed") !== (p.remainingQuantity === 0) || !(p.entryStockPrice > 0)) throw new Error("Invalid saved position");
      } else if (s.position) throw new Error("Unexpected saved position");
    }
    if (reserved !== raw.reservedPositions) throw new Error("Invalid saved risk reservations");
    this.#state = new Map(this.config.symbols.map(symbol => [symbol, structuredClone(raw.symbols[symbol]!)])); this.#reserved = reserved;
  }
  #reserve(symbol: string, stockPrice: number, at: number, range: SetupRange): OrbIntent[] {
    const s = this.#need(symbol);
    if (s.status !== "watching") return [];
    if (this.#reserved >= this.config.maximumPositions) { s.status = "skipped"; return []; }
    s.status = "entry_pending"; s.range = structuredClone(range); this.#reserved++;
    return [{ kind: "enter_calls", setup: range.setup, symbol, stockPrice, at, range: structuredClone(range) }];
  }
  #need(symbol: string): SymbolState { const s = this.#state.get(symbol); if (!s) throw new Error("Symbol outside run universe"); return s; }
}
