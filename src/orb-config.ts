import { ENTRY_WINDOW_MINUTES, SETTINGS, parseOrbOptionsConfig, type OrbOptionsConfig } from "./orb-options.ts";
/** Optional user settings in internal units (cents, fractions); anything omitted takes the founder's default. */
export interface StrategySettings {
  entryWindowMinutes?: number; budgetCentsPerPosition?: number; budgetCentsPerDay?: number; minimumContracts?: number;
  maximumContractsPerTrade?: number | null; maximumPositions?: number; maxOptionSpreadFraction?: number; feeReserveCentsPerContract?: number;
}
export interface StrategySetupInput extends StrategySettings { date: string; symbols: string[]; includePremarketLeadMinutes: 0 | 2 }
export const openingRangeConfig = (input: StrategySetupInput): OrbOptionsConfig => parseOrbOptionsConfig({
  date: input.date,
  symbols: input.symbols,
  openingRangeMinutes: 2,
  stopBufferFraction: .001,
  budgetCentsPerPosition: input.budgetCentsPerPosition ?? SETTINGS.budgetCentsPerPosition.default,
  budgetCentsPerDay: input.budgetCentsPerDay ?? SETTINGS.budgetCentsPerDay.default,
  minimumContracts: input.minimumContracts ?? SETTINGS.minimumContracts.default,
  maximumContractsPerTrade: input.maximumContractsPerTrade ?? SETTINGS.maximumContractsPerTrade.default,
  maximumPositions: input.maximumPositions ?? SETTINGS.maximumPositions.default,
  trimGainFraction: .05,
  maximumTrimSteps: 4,
  feeReserveCentsPerContract: input.feeReserveCentsPerContract ?? SETTINGS.feeReserveCentsPerContract.default,
  maxOptionSpreadFraction: input.maxOptionSpreadFraction ?? SETTINGS.maxOptionSpreadFraction.default,
  maxQuoteAgeMs: 5000,
  maxObservationGapMs: 5000,
  pollMs: 1000,
  includePremarketLeadMinutes: input.includePremarketLeadMinutes,
  entryWindowMinutes: input.entryWindowMinutes ?? ENTRY_WINDOW_MINUTES.default,
});
