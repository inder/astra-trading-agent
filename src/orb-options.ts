import { addDays, isTradingDay, isWeekEnder, sessionTimes, tradingSessionsBetween } from "./daily-history.ts";
import { timestamp } from "./validation.ts";
export interface CallQuote { id: string; bid: number; ask: number; askSize: number; updatedAt: string; retrievedAt: string }

export interface OrbOptionsConfig {
  date: string; symbols: string[]; openingRangeMinutes: 2; stopBufferFraction: number;
  budgetCentsPerPosition: number; budgetCentsPerDay: number; minimumContracts: number; maximumContractsPerTrade: number | null;
  maximumPositions: number; firstTargetMultiple: number; middleTargetMultiple: number; finalTargetMultiple: number; backstopFraction: number;
  feeReserveCentsPerContract: number; maxOptionSpreadFraction: number;
  maxQuoteAgeMs: number; maxObservationGapMs: number; pollMs: number; rangeDeadlineMs: number; readFailureHaltMs: number;
  includePremarketLeadMinutes: 0 | 2; entryWindowMinutes: number; flattenLeadMinutes: number;
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
  // Exits (founder rules): sell ceil(n/2) at the first target, the last contract at the final target, any in between at the
  // middle; the stock-based stop sits a buffer below the opening-range low; the Robinhood backstop sells at a fraction of entry.
  stopBufferFraction: { default: 0.001, min: 0, max: 0.05 },
  firstTargetMultiple: { default: 2, min: 1.1, max: 20 },
  middleTargetMultiple: { default: 3, min: 1.1, max: 50 },
  finalTargetMultiple: { default: 5, min: 1.1, max: 100 },
  backstopFraction: { default: 0.5, min: 0.05, max: 0.95 },
  // Minutes before the close when everything still held sells and new entries stop (founder default 1 = 3:59 pm ET).
  flattenLeadMinutes: { default: 1, min: 1, max: 60 },
  // Market-data timing. The gap rule itself is an invariant (never infer an unobserved price path); its length is a setting.
  pollMs: { default: 1000, min: 250, max: 30_000 },
  maxQuoteAgeMs: { default: 5000, min: 1000, max: 60_000 },
  maxObservationGapMs: { default: 5000, min: 1000, max: 60_000 },
  // How long after the first two-minute candle to keep retrying its bars before skipping a stock.
  rangeDeadlineMs: { default: 60_000, min: 0, max: 600_000 },
  // How long market-data reads may keep failing before the run halts.
  readFailureHaltMs: { default: 60_000, min: 5000, max: 900_000 },
} as const;
const inRange = (v: unknown, r: { min: number; max: number }, integer = true) =>
  typeof v === "number" && (integer ? Number.isSafeInteger(v) : Number.isFinite(v)) && v >= r.min && v <= r.max;
export function parseOrbOptionsConfig(raw: unknown): OrbOptionsConfig {
  const c = raw as OrbOptionsConfig;
  const keys = ["date", "symbols", "openingRangeMinutes", "stopBufferFraction", "budgetCentsPerPosition",
    "budgetCentsPerDay", "minimumContracts", "maximumContractsPerTrade", "maximumPositions", "firstTargetMultiple", "middleTargetMultiple", "finalTargetMultiple", "backstopFraction",
    "feeReserveCentsPerContract", "maxOptionSpreadFraction", "maxQuoteAgeMs", "maxObservationGapMs", "pollMs", "rangeDeadlineMs", "readFailureHaltMs",
    "includePremarketLeadMinutes", "entryWindowMinutes", "flattenLeadMinutes"];
  if (!c || Object.keys(c).some(k => !keys.includes(k)) || !isTradingDay(c.date) || !Array.isArray(c.symbols) ||
    c.symbols.length < 1 || c.symbols.length > 20 || new Set(c.symbols).size !== c.symbols.length ||
    c.symbols.some(s => typeof s !== "string" || !/^[A-Z][A-Z0-9.-]{0,9}$/.test(s)) || c.openingRangeMinutes !== 2 ||
    !inRange(c.stopBufferFraction, SETTINGS.stopBufferFraction, false) || !inRange(c.backstopFraction, SETTINGS.backstopFraction, false) ||
    !inRange(c.firstTargetMultiple, SETTINGS.firstTargetMultiple, false) || !inRange(c.middleTargetMultiple, SETTINGS.middleTargetMultiple, false) ||
    !inRange(c.finalTargetMultiple, SETTINGS.finalTargetMultiple, false) ||
    !(c.firstTargetMultiple < c.middleTargetMultiple && c.middleTargetMultiple < c.finalTargetMultiple) ||
    !inRange(c.budgetCentsPerPosition, SETTINGS.budgetCentsPerPosition) || !inRange(c.budgetCentsPerDay, SETTINGS.budgetCentsPerDay) ||
    c.budgetCentsPerDay < c.budgetCentsPerPosition || !inRange(c.minimumContracts, SETTINGS.minimumContracts) ||
    !(c.maximumContractsPerTrade === null || (inRange(c.maximumContractsPerTrade, SETTINGS.maximumContractsPerTrade) && c.maximumContractsPerTrade >= c.minimumContracts)) ||
    !inRange(c.maximumPositions, SETTINGS.maximumPositions) || !inRange(c.feeReserveCentsPerContract, SETTINGS.feeReserveCentsPerContract) ||
    !inRange(c.maxOptionSpreadFraction, SETTINGS.maxOptionSpreadFraction, false) || !inRange(c.flattenLeadMinutes, SETTINGS.flattenLeadMinutes) ||
    // The cheapest possible contract is $0.01 (100 cents) plus the fee reserve: a minimum that can never fit trades nothing all day.
    c.minimumContracts * (100 + c.feeReserveCentsPerContract) > c.budgetCentsPerPosition ||
    !inRange(c.pollMs, SETTINGS.pollMs) || !inRange(c.maxQuoteAgeMs, SETTINGS.maxQuoteAgeMs) || !inRange(c.maxObservationGapMs, SETTINGS.maxObservationGapMs) ||
    !inRange(c.rangeDeadlineMs, SETTINGS.rangeDeadlineMs) || !inRange(c.readFailureHaltMs, SETTINGS.readFailureHaltMs) ||
    // A poll must fit inside the gap twice (one missed poll is not a gap) and a quote must be allowed to age one poll.
    c.maxObservationGapMs < 2 * c.pollMs || c.maxQuoteAgeMs < c.pollMs || c.readFailureHaltMs < 2 * c.pollMs ||
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
/** Round a price in cents up to the contract's valid increment: the small tick below the cutoff, the larger tick at or above it. */
export function roundUpToTickCents(cents: number, belowCents: number, aboveCents: number, cutoffCents: number): number {
  let rounded = Math.ceil((cents - 1e-8) / (cents < cutoffCents ? belowCents : aboveCents)) * (cents < cutoffCents ? belowCents : aboveCents);
  if (rounded >= cutoffCents) rounded = Math.ceil(rounded / aboveCents) * aboveCents;
  return rounded;
}
/** The Robinhood safety stop: backstopFraction of the entry premium, rounded UP to a valid tick (never more than that fraction lost). */
export function backstopPrice(entryPremium: number, k: Pick<OrbCallContract, "tickBelow" | "tickAbove" | "tickCutoff">, fraction: number): number {
  const cents = roundUpToTickCents(entryPremium * 100 * fraction, Math.round(k.tickBelow * 100), Math.round(k.tickAbove * 100), Math.round(k.tickCutoff * 100));
  return Math.min(cents, Math.round(entryPremium * 100)) / 100;
}
/** Founder exit ladder: ceil(n/2) contracts at the first target (recovers the premium), the last contract at the final
 *  target, and any in between at the middle target. Derived from the original quantity, never stored. */
export function targetSchedule(n: number, c: Pick<OrbOptionsConfig, "firstTargetMultiple" | "middleTargetMultiple" | "finalTargetMultiple">) {
  const first = Math.ceil(n / 2), last = n >= 2 ? 1 : 0, middle = n - first - last;
  return [{ multiple: c.firstTargetMultiple, quantity: first }, { multiple: c.middleTargetMultiple, quantity: middle },
    { multiple: c.finalTargetMultiple, quantity: last }].filter(r => r.quantity > 0);
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
    const limitCents = roundUpToTickCents(q.ask * 100, belowTickCents, aboveTickCents, cutoffCents);
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
export type SaleReason = "protective_stop" | "breakeven_stop" | "broker_backstop" | "profit_target" | "user_trim" | "user_close" | "session_close";
interface Position {
  contractId: string; originalQuantity: number; remainingQuantity: number; entryStockPrice: number;
  entryPremium: number; backstopPrice: number; targetsSold: number; userSold: number; stage: "initial" | "breakeven";
}
interface SymbolState {
  status: Status; range: SetupRange | null; openingRange: OpeningRange | null; endReason: EndReason | null;
  lastTradeMs: number | null; lastObservationMs: number | null; lastPrice: number | null;
  /** While the range's bars are pending: the lowest trade observed at or after the range's end, judged by setRange. */
  lowAfterRangeEnd: number | null;
  position: Position | null; pendingSale: number; pendingReason: SaleReason | null;
}
export type OrbIntent =
  | { kind: "enter_calls"; setup: OrbSetup; symbol: string; stockPrice: number; at: number; range: SetupRange }
  | { kind: "sell_to_close"; reason: SaleReason; symbol: string; contractId: string; quantity: number; stockPrice: number | null; at: number;
      optionBid?: number; targets?: number[] };
export interface OrbSnapshot { symbols: Record<string, SymbolState>; reservedPositions: number }
export class OrbOptionsEngine {
  readonly config: OrbOptionsConfig; #state: Map<string, SymbolState>; #reserved = 0;
  /** When the opening range ends is a calendar fact; its high and low come from bars that may arrive later. */
  readonly #rangeEndMs: number;
  /** When the opening range ends (epoch ms): the one source for the runtime's range window. */
  get rangeEndMs(): number { return this.#rangeEndMs; }
  constructor(config: OrbOptionsConfig) {
    this.config = parseOrbOptionsConfig(config);
    this.#rangeEndMs = sessionTimes(this.config.date).open + this.config.openingRangeMinutes * 60000;
    this.#state = new Map(this.config.symbols.map(s => [s, { status: "forming", range: null, openingRange: null, endReason: null,
      lastTradeMs: null, lastObservationMs: null, lastPrice: null, lowAfterRangeEnd: null, position: null, pendingSale: 0, pendingReason: null }]));
  }
  setRange(symbol: string, range: OpeningRange): void {
    const s = this.#need(symbol);
    const duration = (this.config.openingRangeMinutes + this.config.includePremarketLeadMinutes) * 60000;
    if (s.status !== "forming" || range.endMs - range.startMs !== duration || !(range.high >= range.low && range.low > 0)) throw new Error("Invalid/finalized opening range");
    s.openingRange = structuredClone(range); s.range = { ...structuredClone(range), setup: "opening_range" }; s.status = "watching";
    // Trades observed while the bars were pending count: one beneath the low already ended the day. None of them can
    // enter (the entry rule is a level, so a stock still above the high enters on the next live observation).
    if (s.lowAfterRangeEnd !== null && s.lowAfterRangeEnd < range.low) { s.status = "disqualified"; s.endReason = "opening_low_failed"; }
    s.lowAfterRangeEnd = null;
  }
  /** No usable opening range: the symbol has no route to an entry today. */
  failRange(symbol: string, reason: "range_unavailable" | "late_first_quote" = "range_unavailable"): void {
    const s = this.#need(symbol); if (s.status !== "forming") throw new Error("Opening range already finalized");
    s.status = "disqualified"; s.endReason = reason;
  }
  /** End watching, or waiting for a range, for the day (never affects an entry or position already in progress). */
  disqualify(symbol: string, reason: EndReason): void {
    const s = this.#need(symbol);
    if (s.status === "watching" || s.status === "forming") { s.status = "disqualified"; s.endReason = reason; }
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
    s.lastTradeMs = at; s.lastPrice = stockPrice;
    if (s.status === "forming" && at >= this.#rangeEndMs) s.lowAfterRangeEnd = Math.min(s.lowAfterRangeEnd ?? stockPrice, stockPrice);
    if (s.status === "watching" && s.openingRange && at >= s.openingRange.endMs) {
      // The founder's rule: a trade beneath the opening-range low ends the day for this symbol, even if it later rallies.
      // Checked at the polled-trade resolution; a dip that reverses between polls can be missed (documented limitation).
      if (at >= this.entryDeadline()!) this.disqualify(symbol, "entry_window_closed");
      else if (stockPrice < s.openingRange.low) this.disqualify(symbol, "opening_low_failed");
      else if (stockPrice > s.openingRange.high) return this.#reserve(symbol, stockPrice, at, { ...structuredClone(s.openingRange), setup: "opening_range" });
    }
    if (s.status !== "open" || !s.position || !s.range || s.pendingSale) return [];
    const p = s.position;
    // Before the first target: the opening-range stop. After it (founder ruling): the stock back to its entry price.
    if (p.stage === "breakeven" ? stockPrice <= p.entryStockPrice : stockPrice < s.range.low * (1 - this.config.stopBufferFraction))
      return this.#sellAll(symbol, p.stage === "breakeven" ? "breakeven_stop" : "protective_stop", stockPrice, at);
    return [];
  }
  /** Option-price exits from a fresh bid: the simulated Robinhood backstop, then every newly reached target in one sale. */
  observeOption(symbol: string, bid: number, at: number): OrbIntent[] {
    const s = this.#need(symbol), p = s.position;
    if (!(bid > 0) || !Number.isFinite(bid) || !Number.isFinite(at)) throw new Error("Invalid option bid");
    if (s.status !== "open" || !p || s.pendingSale) return [];
    if (bid <= p.backstopPrice + 1e-9) return this.#sellAll(symbol, "broker_backstop", s.lastPrice, at, bid);
    const consumed = p.targetsSold + p.userSold; let end = 0, sellTo = consumed; const targets: number[] = [];
    for (const rung of targetSchedule(p.originalQuantity, this.config)) {
      end += rung.quantity;
      if (end <= consumed) continue;
      if (bid * 100 + 1e-6 < rung.multiple * p.entryPremium * 100) break;
      sellTo = end; targets.push(rung.multiple);
    }
    const quantity = sellTo - consumed;
    if (quantity <= 0) return [];
    s.pendingSale = quantity; s.pendingReason = "profit_target";
    return [{ kind: "sell_to_close", reason: "profit_target", symbol, contractId: p.contractId, quantity, stockPrice: s.lastPrice, at, optionBid: bid, targets }];
  }
  confirmEntry(symbol: string, contractId: string, quantity: number, entryStockPrice: number, entryPremium: number, backstop: number): void {
    const s = this.#need(symbol);
    if (s.status !== "entry_pending" || !/^[a-f0-9-]{36}$/.test(contractId) || !Number.isInteger(quantity) || quantity < this.config.minimumContracts ||
      (this.config.maximumContractsPerTrade !== null && quantity > this.config.maximumContractsPerTrade) || !(entryStockPrice > 0) ||
      !(entryPremium > 0 && Number.isFinite(entryPremium)) || !(backstop > 0 && backstop <= entryPremium)) throw new Error("Invalid entry confirmation");
    s.position = { contractId, originalQuantity: quantity, remainingQuantity: quantity, entryStockPrice, entryPremium, backstopPrice: backstop,
      targetsSold: 0, userSold: 0, stage: "initial" };
    s.status = "open";
  }
  failEntry(symbol: string): void {
    const s = this.#need(symbol); if (s.status !== "entry_pending") throw new Error("No pending entry");
    s.status = "skipped"; this.#reserved--;
  }
  confirmSale(symbol: string, quantity: number): void {
    const s = this.#need(symbol), p = s.position;
    if (s.status !== "open" || !p || quantity !== s.pendingSale || quantity > p.remainingQuantity) throw new Error("Invalid sale confirmation");
    if (s.pendingReason === "profit_target") {
      // Any engine target fill means the option reached at least the first target, so the stop moves to breakeven;
      // a user trim does not (the user may trim a loser).
      p.stage = "breakeven"; p.targetsSold += quantity;
    } else if (s.pendingReason === "user_trim") p.userSold += quantity;
    p.remainingQuantity -= quantity; s.pendingSale = 0; s.pendingReason = null;
    if (!p.remainingQuantity) s.status = "closed";
  }
  failSale(symbol: string): void { const s = this.#need(symbol); if (!s.pendingSale) throw new Error("No pending sale"); s.pendingSale = 0; s.pendingReason = null; }
  /** Money lost: contracts still unsold at the close end the day as a total loss of their remaining premium. */
  writeOff(symbol: string): number {
    const s = this.#need(symbol), p = s.position;
    if (s.status !== "open" || !p) return 0;
    const quantity = p.remainingQuantity; p.remainingQuantity = 0; s.pendingSale = 0; s.pendingReason = null; s.status = "closed";
    return quantity;
  }
  requestPositionSale(symbol: string, reason: Exclude<SaleReason, "profit_target">, quantity: number, expectedRemainingQuantity: number,
    stockPrice: number | null, at: number): OrbIntent[] {
    const s = this.#need(symbol), p = s.position;
    if (s.status !== "open" || !p || s.pendingSale || !Number.isSafeInteger(quantity) || quantity <= 0 ||
      !Number.isSafeInteger(expectedRemainingQuantity) || expectedRemainingQuantity !== p.remainingQuantity || quantity > p.remainingQuantity ||
      (reason !== "user_trim" && quantity !== p.remainingQuantity) || !(stockPrice === null || stockPrice > 0) || !Number.isFinite(at)) return [];
    s.pendingSale = quantity; s.pendingReason = reason;
    return [{ kind: "sell_to_close", reason, symbol, contractId: p.contractId, quantity, stockPrice: stockPrice ?? s.lastPrice, at }];
  }
  #sellAll(symbol: string, reason: SaleReason, stockPrice: number | null, at: number, optionBid?: number): OrbIntent[] {
    const s = this.#need(symbol), p = s.position!; s.pendingSale = p.remainingQuantity; s.pendingReason = reason;
    return [{ kind: "sell_to_close", reason, symbol, contractId: p.contractId, quantity: p.remainingQuantity, stockPrice, at, ...(optionBid ? { optionBid } : {}) }];
  }
  snapshot(): OrbSnapshot { return { symbols: Object.fromEntries([...this.#state].map(([k, v]) => [k, structuredClone(v)])), reservedPositions: this.#reserved }; }
  restore(raw: OrbSnapshot): void {
    if (!raw || !raw.symbols || Object.keys(raw.symbols).length !== this.config.symbols.length ||
      !Number.isInteger(raw.reservedPositions) || raw.reservedPositions < 0 || raw.reservedPositions > this.config.maximumPositions)
      throw new Error("Invalid engine checkpoint");
    let reserved = 0;
    for (const symbol of this.config.symbols) {
      const s = raw.symbols[symbol];
      if (!s || !["forming", "watching", "disqualified", "open", "closed", "skipped"].includes(s.status) || s.pendingSale !== 0 || s.pendingReason !== null)
        throw new Error("Checkpoint contains incomplete transaction");
      if (!(s.endReason === null || END_REASONS.includes(s.endReason)) || (s.status === "disqualified") !== (s.endReason !== null) ||
        (s.status === "watching" && !s.openingRange) || !(s.lastPrice === null || (Number.isFinite(s.lastPrice) && s.lastPrice > 0)) ||
        !(s.lowAfterRangeEnd === null || ((s.status === "forming" || s.status === "disqualified") && Number.isFinite(s.lowAfterRangeEnd) && s.lowAfterRangeEnd > 0)))
        throw new Error("Invalid saved symbol state");
      if (["open", "closed"].includes(s.status)) {
        const p = s.position; reserved++;
        if (!p || !s.range || !(s.range.high >= s.range.low && s.range.low > 0) ||
          !/^[a-f0-9-]{36}$/.test(p.contractId) || !Number.isSafeInteger(p.originalQuantity) || p.originalQuantity < this.config.minimumContracts ||
          (this.config.maximumContractsPerTrade !== null && p.originalQuantity > this.config.maximumContractsPerTrade) ||
          !Number.isInteger(p.remainingQuantity) || p.remainingQuantity < 0 || p.remainingQuantity > p.originalQuantity ||
          (s.status === "closed") !== (p.remainingQuantity === 0) || !(p.entryStockPrice > 0) ||
          !(p.entryPremium > 0) || !(p.backstopPrice > 0 && p.backstopPrice <= p.entryPremium) || !["initial", "breakeven"].includes(p.stage) ||
          !Number.isSafeInteger(p.targetsSold) || p.targetsSold < 0 || !Number.isSafeInteger(p.userSold) || p.userSold < 0 ||
          (p.stage === "breakeven") !== (p.targetsSold > 0) ||
          (s.status === "open" && p.originalQuantity - p.remainingQuantity !== p.targetsSold + p.userSold)) throw new Error("Invalid saved position");
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
