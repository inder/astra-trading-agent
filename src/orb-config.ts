import { SETTINGS, SETTING_KEYS, parseOrbOptionsConfig, type OrbOptionsConfig, type SettingKey } from "./orb-options.ts";
/** Optional user settings in internal units (cents, fractions, ms); anything omitted takes the founder's default. */
export type StrategySettings = { [K in SettingKey]?: (typeof SETTINGS)[K]["default"] extends null ? number | null : number };
export interface StrategySetupInput extends StrategySettings { date: string; symbols: string[]; includePremarketLeadMinutes: 0 | 2 }
/** The pinned config's key order. A run's config hash covers its JSON, so this order is part of every saved run's
 *  identity: re-configuring a saved run ID with the same settings must produce the same hash. Never reorder it; a new
 *  setting is appended after it automatically, in SETTINGS order. */
const PINNED_ORDER = ["date", "symbols", "openingRangeMinutes", "stopBufferFraction", "budgetCentsPerPosition", "budgetCentsPerDay",
  "minimumContracts", "maximumContractsPerTrade", "maximumPositions", "firstTargetMultiple", "middleTargetMultiple", "finalTargetMultiple",
  "backstopFraction", "feeReserveCentsPerContract", "maxOptionSpreadFraction", "maxQuoteAgeMs", "maxObservationGapMs", "pollMs",
  "rangeDeadlineMs", "readFailureHaltMs", "maxEntryQuoteBatches", "maxEntryAttempts", "heartbeatMs", "includePremarketLeadMinutes",
  "entryWindowMinutes", "flattenLeadMinutes"] as const;
export const CONFIG_KEY_ORDER: readonly string[] = [...PINNED_ORDER, ...SETTING_KEYS.filter(k => !(PINNED_ORDER as readonly string[]).includes(k))];
export const openingRangeConfig = (input: StrategySetupInput): OrbOptionsConfig => {
  const values: Record<string, unknown> = { date: input.date, symbols: input.symbols, openingRangeMinutes: 2,
    includePremarketLeadMinutes: input.includePremarketLeadMinutes,
    ...Object.fromEntries(SETTING_KEYS.map(k => [k, input[k] ?? SETTINGS[k].default])) };
  return parseOrbOptionsConfig(Object.fromEntries(CONFIG_KEY_ORDER.map(k => [k, values[k]])));
};
