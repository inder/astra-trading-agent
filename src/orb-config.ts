import { SETTINGS, SETTING_KEYS, parseOrbOptionsConfig, type OrbOptionsConfig, type SettingKey } from "./orb-options.ts";
/** Optional user settings in internal units (cents, fractions, ms); anything omitted takes the founder's default. */
export type StrategySettings = { [K in SettingKey]?: (typeof SETTINGS)[K]["default"] extends null ? number | null : number };
export interface StrategySetupInput extends StrategySettings { date: string; symbols: string[]; includePremarketLeadMinutes: 0 | 2 }
export const openingRangeConfig = (input: StrategySetupInput): OrbOptionsConfig => parseOrbOptionsConfig({
  date: input.date,
  symbols: input.symbols,
  openingRangeMinutes: 2,
  includePremarketLeadMinutes: input.includePremarketLeadMinutes,
  ...Object.fromEntries(SETTING_KEYS.map(k => [k, input[k] ?? SETTINGS[k].default])),
});
