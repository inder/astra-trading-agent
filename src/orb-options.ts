import { addDays, isTradingDay, isWeekEnder, sessionTimes, tradingSessionsBetween } from "./daily-history.ts";
import { barCandleCloses, breakoutAbove, newCandleState, observeCandles, protectiveStopHit, protectiveStopLevel, setupCancelled, stopAnchor,
  type CandleClose, type CandleState } from "./orb-rules.ts";
import { timestamp } from "./validation.ts";
export interface CallQuote { id: string; bid: number; ask: number; askSize: number; updatedAt: string; retrievedAt: string }

/** A run's pinned configuration: the run's identity plus one value per SETTINGS row, in internal units. */
export type OrbOptionsConfig = { date: string; symbols: string[]; openingRangeMinutes: 2; includePremarketLeadMinutes: 0 | 2 }
  & { [K in Exclude<SettingKey, "maximumContractsPerTrade">]: number } & { maximumContractsPerTrade: number | null };
/** The opening range: the first two minutes of the regular session. A new run must start before it completes. */
export const OPENING_RANGE_MINUTES = 2;
/** How a setting is entered at the chat edge (MCP), versus its internal unit in the pinned config. */
export type SettingUnit = "dollars" | "percent" | "seconds" | "whole" | "multiple";
/** One user setting: the founder default, the validated range, and how the chat edge names and describes it.
 *  `{default}` in the description is replaced by the default in the chat unit. */
export interface SettingSpec { default: number | null; min: number; max: number; integer: boolean;
  mcp: { name: string; unit: SettingUnit; description: string } }
const setting = <D extends number | null>(default_: D, min: number, max: number, integer: boolean, name: string, unit: SettingUnit,
  description: string): SettingSpec & { default: D } => ({ default: default_, min, max, integer, mcp: { name, unit, description } });
/** User settings: the one table every layer reads, in the order the chat tool lists them. parseOrbOptionsConfig checks each row's range, orb-config fills its
 *  default, and the MCP configure tool exposes it in human units. A new rule's setting is one row here. Premium is
 *  treated as money lost, so the caps are the risk control. maximumContractsPerTrade null = bounded only by the
 *  displayed ask size. Cross-setting constraints stay hand-written in parseOrbOptionsConfig. */
export const SETTINGS = {
  entryWindowMinutes: setting(90, 5, 390, true, "entryWindowMinutes", "whole",
    "Minutes after the 9:30 ET open during which new entries may start; default {default} (11:00 ET). Open positions are managed all day."),
  budgetCentsPerPosition: setting(200_000, 10_000, 5_000_000, true, "maxPremiumPerTradeDollars", "dollars",
    "Most premium one trade may commit, treated as money that can be lost entirely; default {default}."),
  budgetCentsPerDay: setting(400_000, 10_000, 10_000_000, true, "maxPremiumPerDayDollars", "dollars",
    "Most premium committed per day across trades (sales never refund it); default {default}."),
  minimumContracts: setting(4, 1, 100, true, "minimumContracts", "whole",
    "Fewest contracts per entry; the strike nearest the money that fits this many is chosen, then filled to the cap. Default {default}."),
  maximumContractsPerTrade: setting(null, 1, 1_000_000, true, "maximumContractsPerTrade", "whole",
    "Optional ceiling on contracts per entry; by default only the displayed ask size limits the fill."),
  maximumPositions: setting(2, 1, 10, true, "maximumPositions", "whole", "Most stocks entered per day; default {default}."),
  maxOptionSpreadFraction: setting(0.2, 0.01, 0.5, false, "maxOptionSpreadPercent", "percent",
    "Widest bid-ask spread accepted, as a percent of the midpoint; default {default}."),
  feeReserveCentsPerContract: setting(100, 0, 1000, true, "feeReserveCentsPerContract", "whole",
    "Cents reserved per contract for fees inside the cap; default {default}."),
  // Exits (founder rules): sell ceil(n/2) at the first target, the last contract at the final target, any in between at the
  // middle; the stock-based stop sits a buffer below the opening-range low; the Robinhood backstop sells at a fraction of entry.
  firstTargetMultiple: setting(2, 1.1, 20, false, "firstTargetMultiple", "multiple",
    "Option bid as a multiple of entry at which half the contracts (rounded up) sell; default {default}x."),
  middleTargetMultiple: setting(3, 1.1, 50, false, "middleTargetMultiple", "multiple",
    "Multiple for contracts between the first half and the last one; default {default}x."),
  finalTargetMultiple: setting(5, 1.1, 100, false, "finalTargetMultiple", "multiple", "Multiple for the last contract; default {default}x."),
  backstopFraction: setting(0.5, 0.05, 0.95, false, "backstopPercent", "percent",
    "Robinhood safety stop as a percent of the entry premium; default {default}."),
  // The protective stop (founder, 2026-10-04): from entry until the position is closed, a candle closing beneath the
  // lowest price seen from the open through the entry, less this buffer, sells everything. There is no breakeven stop.
  stopBufferFraction: setting(0, 0, 0.05, false, "stopBufferPercent", "percent",
    "How far below the stop's anchor (the lowest price from the open through the entry) a candle must close to sell everything, in percent; default {default}."),
  // Minutes before the close when everything still held sells and new entries stop (founder default 1 = 3:59 pm ET).
  flattenLeadMinutes: setting(1, 1, 60, true, "flattenLeadMinutes", "whole",
    "Minutes before the close when everything still held sells and new entries stop; default {default} (3:59 pm ET)."),
  // Market-data timing. The gap rule itself is an invariant (never infer an unobserved price path); its length is a setting.
  pollMs: setting(1000, 250, 30_000, true, "pollSeconds", "seconds", "Seconds between market-data polls; default {default}."),
  maxQuoteAgeMs: setting(5000, 1000, 60_000, true, "maxQuoteAgeSeconds", "seconds",
    "Oldest a stock or option quote may be when fetched and still be acted on; default {default}; at least one poll."),
  maxObservationGapMs: setting(5000, 1000, 60_000, true, "maxObservationGapSeconds", "seconds",
    "Longest gap between observations before a watched stock is dropped for the day, so an unseen price path is never assumed; default {default}; at least two polls."),
  // How long after the first two-minute candle to keep retrying its bars before skipping a stock.
  rangeDeadlineMs: setting(60_000, 0, 600_000, true, "rangeDeadlineSeconds", "seconds",
    "How long after 9:32 ET to keep retrying the opening-range bars before skipping a stock; default {default}."),
  // Entry quoting: batches of the nearest strikes quoted before giving up (15 x 20 = the old whole-catalog cap of 300).
  maxEntryQuoteBatches: setting(3, 1, 15, true, "maxEntryQuoteBatches", "whole",
    "Most batches of 20 nearest strikes quoted at an entry before skipping it; default {default}."),
  // Entry attempts per stock per day (founder rule): an attempt whose own stock quote is back at or below the opening high
  // returns the stock to watching, so a later breakout still enters while the low holds. 1 = the first attempt only. A
  // quote no newer than the breakout trade uses an attempt too: it bounds retries while a lagging feed repeats a trade.
  maxEntryAttempts: setting(3, 1, 10, true, "maxEntryAttempts", "whole",
    "Entry attempts per stock per day. An attempt whose own quote is back at or below the opening high (or is no newer than the breakout trade) uses one attempt and returns the stock to watching for a later breakout while the low holds; default {default}, 1 = the first attempt only."),
  // Journal heartbeat: latest prices, the price range seen, marks and read failures, between state changes.
  heartbeatMs: setting(60_000, 5000, 600_000, true, "heartbeatSeconds", "seconds",
    "Seconds between journal heartbeats (latest prices, price range seen, marks, read failures); default {default}."),
  // How long market-data reads may keep failing before the run halts.
  readFailureHaltMs: setting(60_000, 5000, 900_000, true, "readFailureHaltSeconds", "seconds",
    "How long market-data reads may keep failing before the run halts; with positions open only if option prices fail too; default {default}."),
  // What ends a stock's setup before entry (founder, 2026-10-04): a candle closing this many range heights beneath the
  // opening-range low. Wicks and single prints never do. 0 = any close beneath the low.
  openingLowToleranceRanges: setting(1, 0, 3, false, "openingLowToleranceRanges", "multiple",
    "How far below the opening-range low a candle must close to end a stock's day before entry, in range heights (range high minus low); default {default}. A wick or a single print never ends it."),
  // Both candle rules use one grid, starting when the opening range ends and never rolling.
  candleMinutes: setting(2, 1, 30, true, "candleMinutes", "whole",
    "Length in minutes of the candles whose closes decide the cancel before entry and the protective stop after it, on a grid starting when the opening range ends (9:32 ET); default {default}."),
} as const satisfies Record<string, SettingSpec>;
export type SettingKey = keyof typeof SETTINGS;
export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];
/** User-tunable minutes after the 9:30 open during which new entries may start (founder default 90 = 11:00 ET). */
export const ENTRY_WINDOW_MINUTES = SETTINGS.entryWindowMinutes;
const inRange = (v: unknown, r: { min: number; max: number }, integer = true) =>
  typeof v === "number" && (integer ? Number.isSafeInteger(v) : Number.isFinite(v)) && v >= r.min && v <= r.max;
/** A setting's value is in its row's range (null only where the default is null). */
export const validSetting = (key: SettingKey, v: unknown) => (v === null && SETTINGS[key].default === null) || inRange(v, SETTINGS[key], SETTINGS[key].integer);
export function parseOrbOptionsConfig(raw: unknown): OrbOptionsConfig {
  const c = raw as OrbOptionsConfig;
  const keys: string[] = ["date", "symbols", "openingRangeMinutes", "includePremarketLeadMinutes", ...SETTING_KEYS];
  if (!c || Object.keys(c).some(k => !keys.includes(k)) || !isTradingDay(c.date) || !Array.isArray(c.symbols) ||
    c.symbols.length < 1 || c.symbols.length > 20 || new Set(c.symbols).size !== c.symbols.length ||
    c.symbols.some(s => typeof s !== "string" || !/^[A-Z][A-Z0-9.-]{0,9}$/.test(s)) || c.openingRangeMinutes !== 2 ||
    SETTING_KEYS.some(k => !validSetting(k, c[k])) ||
    !(c.firstTargetMultiple < c.middleTargetMultiple && c.middleTargetMultiple < c.finalTargetMultiple) ||
    c.budgetCentsPerDay < c.budgetCentsPerPosition ||
    !(c.maximumContractsPerTrade === null || c.maximumContractsPerTrade >= c.minimumContracts) ||
    // The cheapest possible contract is $0.01 (100 cents) plus the fee reserve: a minimum that can never fit trades nothing all day.
    c.minimumContracts * (100 + c.feeReserveCentsPerContract) > c.budgetCentsPerPosition ||
    c.heartbeatMs < c.pollMs ||
    // A poll must fit inside the gap twice (one missed poll is not a gap) and a quote must be allowed to age one poll.
    c.maxObservationGapMs < 2 * c.pollMs || c.maxQuoteAgeMs < c.pollMs || c.readFailureHaltMs < 2 * c.pollMs ||
    ![0, 2].includes(c.includePremarketLeadMinutes))
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
/** Lowest minute-bar low from `start` (inclusive) to `end` (exclusive): the stop anchor's view of prices between polls.
 *  null when the bars are missing or unusable; the anchor then rests on the range low and observed trades. */
export function minuteBarLow(raw: unknown, symbol: string, start: number, end: number): number | null {
  const rows = ((raw as any)?.data?.results as any[] | undefined)?.filter(r => r?.symbol === symbol);
  if (!rows || rows.length !== 1 || !Array.isArray(rows[0]?.bars)) return null;
  const lows = (rows[0].bars as any[]).filter(b => { const at = timestamp(b?.begins_at); return at >= start && at < end && b?.interpolated !== true; })
    .map(b => Number(b.low_price)).filter(v => Number.isFinite(v) && v > 0);
  return lows.length ? Math.min(...lows) : null;
}
export interface ReplayResult { symbol: string; range: OpeningRange; outcome: "qualified" | "disqualified" | "no_event"; eventAt: string | null; eventPrice: number | null }
/** The rules applied to minute bars: the breakout is the first bar trading above the high; the cancel is the first
 *  candle (on the grid from the range end) closing beneath the cancel level. Whichever happens first decides. */
export function replayOpeningRange(raw: unknown, symbol: string, startMs: number, leadMinutes = 0,
  tolerance: number = SETTINGS.openingLowToleranceRanges.default, minutes: number = SETTINGS.candleMinutes.default): ReplayResult {
  const range = parseOpeningRange(raw, symbol, startMs, 2, leadMinutes);
  const rows = (((raw as any).data.results as any[]).find(r => r?.symbol === symbol).bars as any[])
    .filter(b => timestamp(b?.begins_at) >= range.endMs && b?.interpolated !== true)
    .map(b => ({ at: timestamp(b.begins_at), begins_at: b.begins_at as string, high: Number(b.high_price), low: Number(b.low_price), open: Number(b.open_price), close: Number(b.close_price) }))
    .sort((x, y) => x.at - y.at);
  if (rows.some(b => !(b.high > 0 && b.low > 0 && b.high >= b.low && b.close > 0))) throw new Error("Invalid replay bar");
  const up = rows.find(b => breakoutAbove(b.high, range).fired);
  const down = barCandleCloses(rows, range.endMs, minutes).find(c => setupCancelled(c, range, tolerance).fired);
  if (up && (!down || up.at < down.end))
    return { symbol, range, outcome: "qualified", eventAt: up.begins_at, eventPrice: Number.isFinite(up.open) && up.open > 0 ? Math.max(range.high, up.open) : range.high };
  if (down) return { symbol, range, outcome: "disqualified", eventAt: new Date(down.end).toISOString(), eventPrice: down.close };
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
  readonly reason: string; readonly evidence: Record<string, unknown>;
  /** evidence: the observation behind the decision, journaled with it. */
  constructor(reason: string, evidence: Record<string, unknown> = {}) { super(reason); this.reason = reason; this.evidence = evidence; }
}
/** The provider's per-request limit on option quotes. */
export const QUOTE_BATCH_SIZE = 20;
/** Contracts nearest the stock price first (ties by id), cut into quote batches that never split contracts at the same
 *  distance: selecting the nearest qualifying strike batch by batch then equals selecting it over the whole catalog. */
export function strikeBatches(contracts: readonly OrbCallContract[], stockPrice: number, size = QUOTE_BATCH_SIZE): OrbCallContract[][] {
  const distance = (k: OrbCallContract) => Math.abs(k.strike - stockPrice);
  const ranked = [...contracts].sort((a, b) => distance(a) - distance(b) || a.id.localeCompare(b.id));
  const batches: OrbCallContract[][] = [];
  for (let i = 0; i < ranked.length;) {
    let end = Math.min(i + size, ranked.length);
    while (end < ranked.length && end > i + 1 && distance(ranked[end - 1]!) === distance(ranked[end]!)) end--;
    batches.push(ranked.slice(i, end)); i = end;
  }
  return batches;
}
export const MIN_EXPIRY_SESSIONS = 3;
/** Founder rule (2026-09-10): the first week-ending expiry with at least 3 trading sessions counting the
 *  trade day — Mon–Wed trades use that Friday, Thu/Fri the next; holiday weeks count real sessions (the
 *  Wednesday before Thanksgiving gets the following Friday). The target must be LISTED; otherwise null,
 *  because a later expiry is a different trade. Mon/Wed daily expiries are never chosen. */
export function preferredWeeklyExpiration(listed: readonly string[], date: string): string | null {
  const target = weeklyExpiryTarget(date);
  return listed.includes(target) ? target : null;
}
/** The expiry the rule above targets for a trade date, listed or not. */
export function weeklyExpiryTarget(date: string): string {
  if (!isTradingDay(date)) throw new Error("Unsupported trade date");
  for (let d = date, i = 0; i < 21; d = addDays(d, 1), i++)
    if (isWeekEnder(d) && tradingSessionsBetween(date, d) >= MIN_EXPIRY_SESSIONS) return d;
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
export type SaleReason = "protective_stop" | "broker_backstop" | "profit_target" | "user_trim" | "user_close" | "session_close";
interface Position {
  contractId: string; originalQuantity: number; remainingQuantity: number; entryStockPrice: number;
  entryPremium: number; backstopPrice: number; targetsSold: number; userSold: number;
  /** The protective stop, fixed at entry: the anchor (lowest price from the open through the entry) and the level a
   *  candle must close beneath (the anchor less the buffer). It holds until the position is closed. */
  stopAnchor: number; stopLevel: number;
}
interface SymbolState {
  status: Status; range: SetupRange | null; openingRange: OpeningRange | null; endReason: EndReason | null;
  /** The observation behind endReason (for a cancel: the candle, its close and the level), journaled with it. */
  endEvidence: Record<string, unknown> | null;
  lastTradeMs: number | null; lastObservationMs: number | null; lastPrice: number | null;
  /** This stock's candles on the grid from the range's end (orb-rules.ts observeCandles). */
  candles: CandleState;
  /** The lowest known candle close from the range's end until entry. The cancel rule reads it whenever the stock is
   *  watching, so a candle that closed while the range bars were pending, or during an entry attempt, still counts. */
  lowestClose: CandleClose | null;
  /** The lowest trade observed from the range's end through the entry: one input of the stop anchor. */
  lowestTrade: number | null;
  /** Entries started today; an aborted attempt may return the stock to watching until maxEntryAttempts are used. */
  entryAttempts: number;
  position: Position | null; pendingSale: number; pendingReason: SaleReason | null;
}
export type OrbIntent =
  | { kind: "enter_calls"; setup: OrbSetup; symbol: string; stockPrice: number; at: number; observedAt: number; range: SetupRange }
  | { kind: "sell_to_close"; reason: SaleReason; symbol: string; contractId: string; quantity: number; stockPrice: number | null; at: number;
      optionBid?: number; targets?: number[]; evidence?: Record<string, unknown> }
  /** A candle ended while Astra was not watching closely enough to know its close; no rule acted on it. */
  | { kind: "candle_unobserved"; symbol: string; start: number; end: number };
export interface OrbSnapshot { symbols: Record<string, SymbolState>; reservedPositions: number }
/** A saved candle builder: on this run's grid, with consistent fields. */
function validCandles(c: CandleState | undefined, gridStart: number, minutes: number): boolean {
  const n = (v: unknown) => v === null || (typeof v === "number" && Number.isFinite(v));
  return !!c && Number.isSafeInteger(c.nextEnd) && c.nextEnd > gridStart && (c.nextEnd - gridStart) % (minutes * 60000) === 0 &&
    n(c.lastPrice) && n(c.lastTradeMs) && n(c.lastObservedMs) && (c.lastPrice === null) === (c.lastTradeMs === null);
}
export class OrbOptionsEngine {
  readonly config: OrbOptionsConfig; #state: Map<string, SymbolState>; #reserved = 0;
  /** When the opening range ends is a calendar fact; its high and low come from bars that may arrive later. */
  readonly #rangeEndMs: number;
  /** When the opening range ends (epoch ms): the one source for the runtime's range window. */
  get rangeEndMs(): number { return this.#rangeEndMs; }
  constructor(config: OrbOptionsConfig) {
    this.config = parseOrbOptionsConfig(config);
    this.#rangeEndMs = sessionTimes(this.config.date).open + this.config.openingRangeMinutes * 60000;
    this.#state = new Map(this.config.symbols.map(s => [s, { status: "forming", range: null, openingRange: null, endReason: null, endEvidence: null,
      lastTradeMs: null, lastObservationMs: null, lastPrice: null, candles: newCandleState(this.#rangeEndMs, this.config.candleMinutes),
      lowestClose: null, lowestTrade: null, entryAttempts: 0, position: null, pendingSale: 0, pendingReason: null }]));
  }
  setRange(symbol: string, range: OpeningRange): void {
    const s = this.#need(symbol);
    const duration = (this.config.openingRangeMinutes + this.config.includePremarketLeadMinutes) * 60000;
    if (s.status !== "forming" || range.endMs - range.startMs !== duration || !(range.high >= range.low && range.low > 0)) throw new Error("Invalid/finalized opening range");
    s.openingRange = structuredClone(range); s.range = { ...structuredClone(range), setup: "opening_range" }; s.status = "watching";
    // Candles that closed while the bars were pending count: one beneath the cancel level already ended the day. None
    // of the trades seen meanwhile can enter (the entry rule is a level, so a stock still above the high enters on the
    // next live observation).
    this.#judgeCancel(s);
  }
  /** The cancel rule on the lowest close so far, whenever the stock is watching. */
  #judgeCancel(s: SymbolState): void {
    if (s.status !== "watching" || !s.openingRange || !s.lowestClose) return;
    const d = setupCancelled(s.lowestClose, s.openingRange, this.config.openingLowToleranceRanges);
    if (d.fired) { s.status = "disqualified"; s.endReason = d.reason; s.endEvidence = d.evidence; }
  }
  /** No usable opening range: the symbol has no route to an entry today. */
  failRange(symbol: string, reason: "range_unavailable" | "late_first_quote" = "range_unavailable"): void {
    const s = this.#need(symbol); if (s.status !== "forming") throw new Error("Opening range already finalized");
    s.status = "disqualified"; s.endReason = reason; s.endEvidence = null;
  }
  /** End watching, or waiting for a range, for the day (never affects an entry or position already in progress). */
  disqualify(symbol: string, reason: EndReason): void {
    const s = this.#need(symbol);
    if (s.status === "watching" || s.status === "forming") { s.status = "disqualified"; s.endReason = reason; s.endEvidence = null; }
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
    // Candles this observation finishes describe the past, so their rules (cancel, stop) are judged before this trade.
    const intents = this.#candles(symbol, s, stockPrice, at, observedAt);
    if (s.lastObservationMs !== null && observedAt - s.lastObservationMs > this.config.maxObservationGapMs) this.disqualify(symbol, "observation_gap");
    if (s.lastObservationMs !== null && observedAt < s.lastObservationMs) return intents;
    s.lastObservationMs = observedAt;
    if (s.lastTradeMs !== null && at - s.lastTradeMs > this.config.maxObservationGapMs) this.disqualify(symbol, "observation_gap");
    if (s.lastTradeMs !== null && at <= s.lastTradeMs) return intents;
    s.lastTradeMs = at; s.lastPrice = stockPrice;
    if (s.status === "watching" && s.openingRange && at >= s.openingRange.endMs) {
      if (at >= this.entryDeadline()!) this.disqualify(symbol, "entry_window_closed");
      else if (breakoutAbove(stockPrice, s.openingRange).fired)
        return [...intents, ...this.#reserve(symbol, stockPrice, at, observedAt, { ...structuredClone(s.openingRange), setup: "opening_range" })];
    }
    return intents;
  }
  /** A quote too old to act on still says which candles have ended and at what price. It feeds only the candles (and
   *  the stop anchor's low): never an entry, and never the observation-gap rules. */
  observeCandlesOnly(symbol: string, stockPrice: number, at: number, observedAt: number): OrbIntent[] {
    const s = this.#need(symbol); if (!(stockPrice > 0) || !Number.isFinite(at) || !Number.isFinite(observedAt) || at > observedAt) throw new Error("Invalid trade");
    return this.#candles(symbol, s, stockPrice, at, observedAt, false);
  }
  /** One observed trade through the candle builder: the cancel rule before entry, the protective stop after it. */
  #candles(symbol: string, s: SymbolState, price: number, at: number, observedAt: number, fresh = true): OrbIntent[] {
    const beforeEntry = ["forming", "watching", "entry_pending"].includes(s.status);
    if (beforeEntry && at >= this.#rangeEndMs) s.lowestTrade = Math.min(s.lowestTrade ?? price, price);
    const out: OrbIntent[] = [];
    for (const c of observeCandles(s.candles, price, at, observedAt, this.config.candleMinutes, this.config.maxQuoteAgeMs, this.config.maxObservationGapMs, fresh)) {
      if (c.close === null) {
        // One note per stretch of unknown candles (a long gap would otherwise write one per candle).
        const last = out.at(-1);
        if (last?.kind === "candle_unobserved" && last.end === c.start) last.end = c.end;
        else if (beforeEntry || s.status === "open") out.push({ kind: "candle_unobserved", symbol, start: c.start, end: c.end });
        continue;
      }
      if (["forming", "watching", "entry_pending"].includes(s.status)) {
        if (!s.lowestClose || c.close < s.lowestClose.close!) s.lowestClose = c;
        this.#judgeCancel(s);
      } else if (s.status === "open" && s.position && !s.pendingSale) {
        const p = s.position, d = protectiveStopHit(c, p.stopLevel, p.stopAnchor);
        if (d.fired) out.push(...this.#sellAll(symbol, d.reason, c.close, c.end, undefined, d.evidence));
      }
    }
    return out;
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
  /** barLow: the lowest minute-bar low from the range's end through the entry, when the runtime could read it. */
  confirmEntry(symbol: string, contractId: string, quantity: number, entryStockPrice: number, entryPremium: number, backstop: number,
    barLow: number | null = null): void {
    const s = this.#need(symbol);
    if (s.status !== "entry_pending" || !/^[a-f0-9-]{36}$/.test(contractId) || !Number.isInteger(quantity) || quantity < this.config.minimumContracts ||
      (this.config.maximumContractsPerTrade !== null && quantity > this.config.maximumContractsPerTrade) || !(entryStockPrice > 0) ||
      !(entryPremium > 0 && Number.isFinite(entryPremium)) || !(backstop > 0 && backstop <= entryPremium)) throw new Error("Invalid entry confirmation");
    const anchor = stopAnchor(s.range!.low, s.lowestTrade, barLow);
    s.position = { contractId, originalQuantity: quantity, remainingQuantity: quantity, entryStockPrice, entryPremium, backstopPrice: backstop,
      targetsSold: 0, userSold: 0, stopAnchor: anchor, stopLevel: protectiveStopLevel(anchor, this.config.stopBufferFraction) };
    s.status = "open";
  }
  /** An entry that did not happen. retry (the entry's own quote did not confirm the breakout) returns the stock to
   *  watching while attempts remain, so a later breakout can enter. retry.quote is that quote when it is a later trade:
   *  it is an observation like any other, so it can finish a candle. A candle that closed beneath the cancel level,
   *  during the attempt or now, ends the day. Every other failure ends the day too. */
  failEntry(symbol: string, retry?: { quote: { price: number; at: number; observedAt: number } | null }): "watching" | "skipped" | "disqualified" {
    const s = this.#need(symbol); if (s.status !== "entry_pending") throw new Error("No pending entry");
    this.#reserved--;
    s.status = retry && s.entryAttempts < this.config.maxEntryAttempts ? "watching" : "skipped";
    if (retry?.quote) this.#candles(symbol, s, retry.quote.price, retry.quote.at, retry.quote.observedAt);
    this.#judgeCancel(s);
    return s.status;
  }
  confirmSale(symbol: string, quantity: number): void {
    const s = this.#need(symbol), p = s.position;
    if (s.status !== "open" || !p || quantity !== s.pendingSale || quantity > p.remainingQuantity) throw new Error("Invalid sale confirmation");
    if (s.pendingReason === "profit_target") p.targetsSold += quantity;
    else if (s.pendingReason === "user_trim") p.userSold += quantity;
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
  #sellAll(symbol: string, reason: SaleReason, stockPrice: number | null, at: number, optionBid?: number, evidence?: Record<string, unknown>): OrbIntent[] {
    const s = this.#need(symbol), p = s.position!; s.pendingSale = p.remainingQuantity; s.pendingReason = reason;
    return [{ kind: "sell_to_close", reason, symbol, contractId: p.contractId, quantity: p.remainingQuantity, stockPrice, at,
      ...(optionBid ? { optionBid } : {}), ...(evidence ? { evidence } : {}) }];
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
      // An entered stock used at least one attempt; a stock still watching has one left.
      if (!Number.isSafeInteger(s.entryAttempts) || s.entryAttempts < 0 || s.entryAttempts > this.config.maxEntryAttempts ||
        (["open", "closed"].includes(s.status) && s.entryAttempts < 1) || (s.status === "watching" && s.entryAttempts >= this.config.maxEntryAttempts))
        throw new Error("Invalid saved entry attempts");
      if (!(s.endReason === null || END_REASONS.includes(s.endReason)) || (s.status === "disqualified") !== (s.endReason !== null) ||
        (s.status === "watching" && !s.openingRange) || !(s.lastPrice === null || (Number.isFinite(s.lastPrice) && s.lastPrice > 0)) ||
        !(s.endEvidence === null || (typeof s.endEvidence === "object" && !Array.isArray(s.endEvidence))) || !validCandles(s.candles, this.#rangeEndMs, this.config.candleMinutes) ||
        !(s.lowestTrade === null || (Number.isFinite(s.lowestTrade) && s.lowestTrade > 0)) ||
        !(s.lowestClose === null || (Number.isFinite(s.lowestClose.close) && s.lowestClose.close! > 0 && Number.isSafeInteger(s.lowestClose.start) &&
          s.lowestClose.end > s.lowestClose.start && Number.isSafeInteger(s.lowestClose.end))))
        throw new Error("Invalid saved symbol state");
      if (["open", "closed"].includes(s.status)) {
        const p = s.position; reserved++;
        if (!p || !s.range || !(s.range.high >= s.range.low && s.range.low > 0) ||
          !/^[a-f0-9-]{36}$/.test(p.contractId) || !Number.isSafeInteger(p.originalQuantity) || p.originalQuantity < this.config.minimumContracts ||
          (this.config.maximumContractsPerTrade !== null && p.originalQuantity > this.config.maximumContractsPerTrade) ||
          !Number.isInteger(p.remainingQuantity) || p.remainingQuantity < 0 || p.remainingQuantity > p.originalQuantity ||
          (s.status === "closed") !== (p.remainingQuantity === 0) || !(p.entryStockPrice > 0) ||
          !(p.entryPremium > 0) || !(p.backstopPrice > 0 && p.backstopPrice <= p.entryPremium) ||
          !(Number.isFinite(p.stopAnchor) && p.stopAnchor > 0 && p.stopAnchor <= s.range.low) ||
          Math.abs(p.stopLevel - protectiveStopLevel(p.stopAnchor, this.config.stopBufferFraction)) > 1e-9 ||
          !Number.isSafeInteger(p.targetsSold) || p.targetsSold < 0 || !Number.isSafeInteger(p.userSold) || p.userSold < 0 ||
          (s.status === "open" && p.originalQuantity - p.remainingQuantity !== p.targetsSold + p.userSold)) throw new Error("Invalid saved position");
      } else if (s.position) throw new Error("Unexpected saved position");
    }
    if (reserved !== raw.reservedPositions) throw new Error("Invalid saved risk reservations");
    this.#state = new Map(this.config.symbols.map(symbol => [symbol, structuredClone(raw.symbols[symbol]!)])); this.#reserved = reserved;
  }
  #reserve(symbol: string, stockPrice: number, at: number, observedAt: number, range: SetupRange): OrbIntent[] {
    const s = this.#need(symbol);
    if (s.status !== "watching") return [];
    if (this.#reserved >= this.config.maximumPositions) { s.status = "skipped"; return []; }
    s.status = "entry_pending"; s.range = structuredClone(range); this.#reserved++; s.entryAttempts++;
    return [{ kind: "enter_calls", setup: range.setup, symbol, stockPrice, at, observedAt, range: structuredClone(range) }];
  }
  #need(symbol: string): SymbolState { const s = this.#state.get(symbol); if (!s) throw new Error("Symbol outside run universe"); return s; }
}
