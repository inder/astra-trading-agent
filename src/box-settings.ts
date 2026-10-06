// The support-box strategy's settings: one row per number, the founder's placeholder default and a validated range. The
// same table pattern as SETTINGS in orb-options.ts (the row helper is shared). The founder tunes these; none is a rule's
// literal. Rules are in box-rules.ts.
import { SETTINGS, setting, type SettingSpec } from "./orb-options.ts";
import { isTradingDay } from "./daily-history.ts";

export const BOX_SETTINGS = {
  // Runaway gate (daily bars before the day). OFF by default: the watchlist the founder gives Astra is already the runaway list.
  useRunawayGate: setting(0, 0, 1, true, "useRunawayGate", "whole", "1 = only stocks that pass the runaway gate below are scanned; 0 = every listed stock is scanned and the gate is not evaluated (the list is taken to be runaways already). Default {default}."),
  shortAveragePeriod: setting(10, 2, 100, true, "shortAveragePeriod", "whole", "Sessions in the short moving average the price must stand above and that must be rising; default {default}."),
  longAveragePeriod: setting(21, 3, 200, true, "longAveragePeriod", "whole", "Sessions in the long moving average the price must stand above and that must be rising; default {default}."),
  risingLookbackSessions: setting(5, 1, 60, true, "risingLookbackSessions", "whole", "An average is rising when it is above its own value this many sessions earlier; default {default}."),
  highLookbackSessions: setting(63, 5, 260, true, "highLookbackSessions", "whole", "Sessions that make the high the price must stay near (63 is about three months); default {default}."),
  maxBelowHighFraction: setting(0.1, 0.01, 0.5, false, "maxBelowHighPercent", "percent", "How far below that high the last close may be, as a percent; default {default}."),
  breakoutLookbackSessions: setting(10, 1, 120, true, "breakoutLookbackSessions", "whole", "A daily close through a prior resistance zone must have happened within this many sessions; default {default}."),
  // Supports (each type on or off: 1 or 0).
  useBrokenResistance: setting(1, 0, 1, true, "useBrokenResistance", "whole", "1 = a resistance zone the price closed above (and the high of that breakout session) is a support; 0 = not. Default {default}."),
  useAverages: setting(1, 0, 1, true, "useAverages", "whole", "1 = the daily moving averages below are supports; 0 = not. Default {default}."),
  averageSupportFastPeriod: setting(10, 0, 200, true, "averageSupportFastPeriod", "whole", "Sessions in a fast daily moving average offered as a support (founder: some stocks find buyers at the 10-day); 0 = none. Default {default}."),
  averageSupportShortPeriod: setting(20, 2, 200, true, "averageSupportShortPeriod", "whole", "Sessions in the first daily moving average offered as a support; default {default}."),
  averageSupportLongPeriod: setting(21, 2, 200, true, "averageSupportLongPeriod", "whole", "Sessions in the second daily moving average offered as a support; default {default}."),
  averageSupportKind: setting(2, 0, 2, true, "averageSupportKind", "whole", "Which daily averages are supports: 0 = simple, 1 = exponential, 2 = both; default {default}."),
  useAnchoredVwaps: setting(1, 0, 1, true, "useAnchoredVwaps", "whole", "1 = a VWAP anchored at the regular-session open 1..N sessions back is a support; 0 = not. Default {default}."),
  vwapMaxSessionsBack: setting(3, 1, 5, true, "vwapMaxSessionsBack", "whole", "Anchor VWAPs at the open this many sessions back and fewer (1 to N); default {default}."),
  vwapIncludesToday: setting(1, 0, 1, true, "vwapIncludesToday", "whole", "1 = an anchored VWAP also counts today's minute bars up to the candle just finished (never later); 0 = through the prior close only. Default {default}."),
  // The box.
  atrPeriod: setting(14, 2, 100, true, "atrPeriod", "whole", "Sessions in the average true range every box number is measured against; default {default}."),
  candleMinutes: SETTINGS.candleMinutes,   // one row, shared with the opening-range strategy: the same grid from 9:32 ET
  maxBoxHeightAtr: setting(0.25, 0.02, 2, false, "maxBoxHeightAtr", "multiple", "Tallest a box may be (highest high minus lowest low), in ATRs; default {default}."),
  minBoxMinutes: setting(10, 2, 120, true, "minBoxMinutes", "whole", "Shortest a box may last, in minutes; default {default}."),
  supportReachAtr: setting(0.08, 0, 3, false, "supportReachAtr", "multiple", "How far above a support the box low may sit, in ATRs; default {default}. A support must be at or below the box low."),
  supportSlackAtr: setting(0, 0, 1, false, "supportSlackAtr", "multiple", "How far above the box low a support may still sit and count, in ATRs; default {default}: a level above the box low is resistance, never its support. Raise it only to tolerate a wick that pokes through a support."),
  // Contraction.
  contractionBaseline: setting(1, 0, 1, true, "contractionBaseline", "whole", "What a box's candles must be quieter than: 1 = the session so far (every candle since 9:32 before the box), 0 = the candles just before the box (contractionLookbackCandles of them). Default {default}."),
  contractionLookbackCandles: setting(5, 2, 30, true, "contractionLookbackCandles", "whole", "Candles before the box whose mean range the box is compared with; default {default}."),
  contractionMaxRatio: setting(0.8, 0.05, 1, false, "contractionMaxRatio", "multiple", "Largest allowed mean candle range in the box's second half, as a multiple of the mean range before the box; default {default}."),
  // Journaled levels (no position is ever opened in this version).
  riskCents: setting(50_000, 1000, 10_000_000, true, "riskDollars", "dollars", "Dollars risked per setup when sizing the journaled shares: risk divided by (entry minus stop); default {default}."),
  entryAFractionOfBox: setting(0.25, 0, 1, false, "entryAPercentOfBox", "percent", "Entry A sits this percent of the box's height above its low; default {default}."),
  // Observation and history (live run). A candle seen through fewer distinct trades than this has an unknown close (docs/decisions/0002).
  minCandleTrades: setting(3, 1, 100, true, "minCandleTrades", "whole", "Fewest distinct trades Astra must have seen inside a candle for its close, high and low to count; fewer and the candle is unobserved. Default {default}."),
  historyDays: setting(760, 120, 1900, true, "historyDays", "whole", "Calendar days of daily history read for each stock before the open (about two years); default {default}."),
  // Market-data timing: the opening-range strategy's own rows, one definition each (the same ranges, defaults and chat names).
  pollMs: SETTINGS.pollMs, maxQuoteAgeMs: SETTINGS.maxQuoteAgeMs, maxObservationGapMs: SETTINGS.maxObservationGapMs,
  heartbeatMs: SETTINGS.heartbeatMs,
} as const satisfies Record<string, SettingSpec>;
export type BoxSettingKey = keyof typeof BOX_SETTINGS;
export const BOX_SETTING_KEYS = Object.keys(BOX_SETTINGS) as BoxSettingKey[];
export type BoxConfig = { date: string; symbols: string[] } & { [K in BoxSettingKey]: number };

const inRange = (v: unknown, r: SettingSpec) => typeof v === "number" && (r.integer ? Number.isSafeInteger(v) : Number.isFinite(v)) && v >= r.min && v <= r.max;
/** The pinned config: the run's identity plus one value per row, every one range-checked. */
export function parseBoxConfig(raw: unknown): BoxConfig {
  if (typeof raw !== "object" || raw === null) throw new Error("Invalid support-box configuration");
  const c = raw as BoxConfig, keys: string[] = ["date", "symbols", ...BOX_SETTING_KEYS];
  if (!c || Object.keys(c).some(k => !keys.includes(k)) || !isTradingDay(c.date) || !Array.isArray(c.symbols) || c.symbols.length < 1 || c.symbols.length > 20 ||
    new Set(c.symbols).size !== c.symbols.length || c.symbols.some(s => typeof s !== "string" || !/^[A-Z][A-Z0-9.-]{0,9}$/.test(s)) ||
    BOX_SETTING_KEYS.some(k => !inRange(c[k], BOX_SETTINGS[k])) || c.shortAveragePeriod >= c.longAveragePeriod ||
    // A box must hold at least two candles (it has no second half otherwise), and a whole number of them.
    c.minBoxMinutes < 2 * c.candleMinutes || c.minBoxMinutes % c.candleMinutes !== 0 ||
    // A candle must be able to hold the distinct trades its close needs: one poll sees at most one new trade.
    c.minCandleTrades * c.pollMs > c.candleMinutes * 60000 ||
    // The same timing relations as the opening-range config: a poll fits in the gap twice, a quote may age one poll.
    c.heartbeatMs < c.pollMs || c.maxObservationGapMs < 2 * c.pollMs || c.maxQuoteAgeMs < c.pollMs) throw new Error("Invalid support-box configuration");
  return structuredClone(c);
}
/** A config with every row at its default, for the given day and symbols (and any overrides, which are validated). */
export function boxConfig(date: string, symbols: string[], overrides: Partial<Record<BoxSettingKey, number>> = {}): BoxConfig {
  return parseBoxConfig({ date, symbols, ...Object.fromEntries(BOX_SETTING_KEYS.map(k => [k, overrides[k] ?? BOX_SETTINGS[k].default])) });
}
/** The pinned config for a run from the chat edge's input: defaults for every omitted setting, in one canonical key order (a run's config
 *  hash covers its JSON). Settings that belong to another strategy, and pre-market bars, are refused rather than ignored. */
export function boxConfigFromInput(input: Record<string, unknown>): BoxConfig {
  const { date, symbols, includePremarketLeadMinutes, ...rest } = input;
  if (includePremarketLeadMinutes) throw new Error("The support-box strategy does not use pre-market bars");
  const foreign = Object.keys(rest).filter(k => rest[k] !== undefined && !(BOX_SETTING_KEYS as string[]).includes(k));
  if (foreign.length) throw new Error(`Setting ${foreign.join(", ")} does not apply to the support-box strategy`);
  return parseBoxConfig({ date, symbols, ...Object.fromEntries(BOX_SETTING_KEYS.map(k => [k, rest[k] ?? BOX_SETTINGS[k].default])) });
}
