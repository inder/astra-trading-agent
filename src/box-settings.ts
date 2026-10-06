// The support-box strategy's settings: one row per number, the founder's placeholder default and a validated range. The
// same table pattern as SETTINGS in orb-options.ts (the row helper is shared). The founder tunes these; none is a rule's
// literal. Rules are in box-rules.ts.
import { setting, type SettingSpec } from "./orb-options.ts";
import { isTradingDay } from "./daily-history.ts";

export const BOX_SETTINGS = {
  // Runaway gate (daily bars before the day).
  shortAveragePeriod: setting(10, 2, 100, true, "shortAveragePeriod", "whole", "Sessions in the short moving average the price must stand above and that must be rising; default {default}."),
  longAveragePeriod: setting(21, 3, 200, true, "longAveragePeriod", "whole", "Sessions in the long moving average the price must stand above and that must be rising; default {default}."),
  risingLookbackSessions: setting(5, 1, 60, true, "risingLookbackSessions", "whole", "An average is rising when it is above its own value this many sessions earlier; default {default}."),
  highLookbackSessions: setting(63, 5, 260, true, "highLookbackSessions", "whole", "Sessions that make the high the price must stay near (63 is about three months); default {default}."),
  maxBelowHighFraction: setting(0.1, 0.01, 0.5, false, "maxBelowHighPercent", "percent", "How far below that high the last close may be, as a percent; default {default}."),
  breakoutLookbackSessions: setting(10, 1, 120, true, "breakoutLookbackSessions", "whole", "A daily close through a prior resistance zone must have happened within this many sessions; default {default}."),
  // Supports (each type on or off: 1 or 0).
  useBrokenResistance: setting(1, 0, 1, true, "useBrokenResistance", "whole", "1 = a resistance zone the price closed above (and the high of that breakout session) is a support; 0 = not. Default {default}."),
  useAverages: setting(1, 0, 1, true, "useAverages", "whole", "1 = the short and long moving averages are supports; 0 = not. Default {default}."),
  useAnchoredVwaps: setting(1, 0, 1, true, "useAnchoredVwaps", "whole", "1 = a VWAP anchored at the regular-session open 1..N sessions back is a support; 0 = not. Default {default}."),
  vwapMaxSessionsBack: setting(3, 1, 5, true, "vwapMaxSessionsBack", "whole", "Anchor VWAPs at the open this many sessions back and fewer (1 to N); default {default}."),
  vwapIncludesToday: setting(1, 0, 1, true, "vwapIncludesToday", "whole", "1 = an anchored VWAP also counts today's minute bars up to the candle just finished (never later); 0 = through the prior close only. Default {default}."),
  // The box.
  atrPeriod: setting(14, 2, 100, true, "atrPeriod", "whole", "Sessions in the average true range every box number is measured against; default {default}."),
  candleMinutes: setting(2, 1, 30, true, "candleMinutes", "whole", "Candle length in minutes, on the grid that starts at 9:32 ET as in the opening-range strategy; default {default}."),
  maxBoxHeightAtr: setting(0.25, 0.02, 2, false, "maxBoxHeightAtr", "multiple", "Tallest a box may be (highest high minus lowest low), in ATRs; default {default}."),
  minBoxMinutes: setting(10, 2, 120, true, "minBoxMinutes", "whole", "Shortest a box may last, in minutes; default {default}."),
  supportReachAtr: setting(0.5, 0, 3, false, "supportReachAtr", "multiple", "How far above a support the box low may sit, in ATRs; default {default}."),
  supportSlackAtr: setting(0.1, 0, 1, false, "supportSlackAtr", "multiple", "How far below a support the box low may poke (a wick through it), in ATRs; default {default}."),
  // Contraction.
  contractionLookbackCandles: setting(5, 2, 30, true, "contractionLookbackCandles", "whole", "Candles before the box whose mean range the box is compared with; default {default}."),
  contractionMaxRatio: setting(0.7, 0.05, 1, false, "contractionMaxRatio", "multiple", "Largest allowed mean candle range in the box's second half, as a multiple of the mean range before the box; default {default}."),
  // Journaled levels (no position is ever opened in this version).
  riskCents: setting(50_000, 1000, 10_000_000, true, "riskDollars", "dollars", "Dollars risked per setup when sizing the journaled shares: risk divided by (entry minus stop); default {default}."),
  entryAFractionOfBox: setting(0.25, 0, 1, false, "entryAPercentOfBox", "percent", "Entry A sits this percent of the box's height above its low; default {default}."),
} as const satisfies Record<string, SettingSpec>;
export type BoxSettingKey = keyof typeof BOX_SETTINGS;
export const BOX_SETTING_KEYS = Object.keys(BOX_SETTINGS) as BoxSettingKey[];
export type BoxConfig = { date: string; symbols: string[] } & { [K in BoxSettingKey]: number };

const inRange = (v: unknown, r: SettingSpec) => typeof v === "number" && (r.integer ? Number.isSafeInteger(v) : Number.isFinite(v)) && v >= r.min && v <= r.max;
/** The pinned config: the run's identity plus one value per row, every one range-checked. */
export function parseBoxConfig(raw: unknown): BoxConfig {
  const c = raw as BoxConfig, keys: string[] = ["date", "symbols", ...BOX_SETTING_KEYS];
  if (!c || Object.keys(c).some(k => !keys.includes(k)) || !isTradingDay(c.date) || !Array.isArray(c.symbols) || c.symbols.length < 1 || c.symbols.length > 20 ||
    new Set(c.symbols).size !== c.symbols.length || c.symbols.some(s => typeof s !== "string" || !/^[A-Z][A-Z0-9.-]{0,9}$/.test(s)) ||
    BOX_SETTING_KEYS.some(k => !inRange(c[k], BOX_SETTINGS[k])) || c.shortAveragePeriod >= c.longAveragePeriod ||
    // A box must hold at least two candles, or it has no second half to compare.
    c.minBoxMinutes < 2 * c.candleMinutes) throw new Error("Invalid support-box configuration");
  return structuredClone(c);
}
/** A config with every row at its default, for the given day and symbols (and any overrides, which are validated). */
export function boxConfig(date: string, symbols: string[], overrides: Partial<Record<BoxSettingKey, number>> = {}): BoxConfig {
  return parseBoxConfig({ date, symbols, ...Object.fromEntries(BOX_SETTING_KEYS.map(k => [k, overrides[k] ?? BOX_SETTINGS[k].default])) });
}
