import { ENTRY_WINDOW_MINUTES, SETTINGS, parseOrbOptionsConfig, type OrbOptionsConfig } from "./orb-options.ts";
/** Optional user settings in internal units (cents, fractions); anything omitted takes the founder's default. */
export interface StrategySettings {
  entryWindowMinutes?: number; budgetCentsPerPosition?: number; budgetCentsPerDay?: number; minimumContracts?: number;
  maximumContractsPerTrade?: number | null; maximumPositions?: number; maxOptionSpreadFraction?: number; feeReserveCentsPerContract?: number;
  stopBufferFraction?: number; firstTargetMultiple?: number; middleTargetMultiple?: number; finalTargetMultiple?: number; backstopFraction?: number;
  flattenLeadMinutes?: number; pollMs?: number; maxQuoteAgeMs?: number; maxObservationGapMs?: number; rangeDeadlineMs?: number; readFailureHaltMs?: number;
}
export interface StrategySetupInput extends StrategySettings { date: string; symbols: string[]; includePremarketLeadMinutes: 0 | 2 }
export const openingRangeConfig = (input: StrategySetupInput): OrbOptionsConfig => parseOrbOptionsConfig({
  date: input.date,
  symbols: input.symbols,
  openingRangeMinutes: 2,
  stopBufferFraction: input.stopBufferFraction ?? SETTINGS.stopBufferFraction.default,
  budgetCentsPerPosition: input.budgetCentsPerPosition ?? SETTINGS.budgetCentsPerPosition.default,
  budgetCentsPerDay: input.budgetCentsPerDay ?? SETTINGS.budgetCentsPerDay.default,
  minimumContracts: input.minimumContracts ?? SETTINGS.minimumContracts.default,
  maximumContractsPerTrade: input.maximumContractsPerTrade ?? SETTINGS.maximumContractsPerTrade.default,
  maximumPositions: input.maximumPositions ?? SETTINGS.maximumPositions.default,
  firstTargetMultiple: input.firstTargetMultiple ?? SETTINGS.firstTargetMultiple.default,
  middleTargetMultiple: input.middleTargetMultiple ?? SETTINGS.middleTargetMultiple.default,
  finalTargetMultiple: input.finalTargetMultiple ?? SETTINGS.finalTargetMultiple.default,
  backstopFraction: input.backstopFraction ?? SETTINGS.backstopFraction.default,
  feeReserveCentsPerContract: input.feeReserveCentsPerContract ?? SETTINGS.feeReserveCentsPerContract.default,
  maxOptionSpreadFraction: input.maxOptionSpreadFraction ?? SETTINGS.maxOptionSpreadFraction.default,
  maxQuoteAgeMs: input.maxQuoteAgeMs ?? SETTINGS.maxQuoteAgeMs.default,
  maxObservationGapMs: input.maxObservationGapMs ?? SETTINGS.maxObservationGapMs.default,
  pollMs: input.pollMs ?? SETTINGS.pollMs.default,
  rangeDeadlineMs: input.rangeDeadlineMs ?? SETTINGS.rangeDeadlineMs.default,
  readFailureHaltMs: input.readFailureHaltMs ?? SETTINGS.readFailureHaltMs.default,
  includePremarketLeadMinutes: input.includePremarketLeadMinutes,
  entryWindowMinutes: input.entryWindowMinutes ?? ENTRY_WINDOW_MINUTES.default,
  flattenLeadMinutes: input.flattenLeadMinutes ?? SETTINGS.flattenLeadMinutes.default,
});
