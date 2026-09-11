import { ENTRY_WINDOW_MINUTES, parseOrbOptionsConfig, type OrbOptionsConfig } from "./orb-options.ts";
export interface StrategySetupInput { date: string; symbols: string[]; includePremarketLeadMinutes: 0 | 2; entryWindowMinutes?: number }
export const openingRangeConfig = (input: StrategySetupInput): OrbOptionsConfig => parseOrbOptionsConfig({
  date: input.date,
  symbols: input.symbols,
  openingRangeMinutes: 2,
  stopBufferFraction: .001,
  budgetCentsPerPosition: 200000,
  minimumContracts: 2,
  preferredContracts: 4,
  maximumPositions: 2,
  trimGainFraction: .05,
  maximumTrimSteps: 4,
  feeReserveCentsPerContract: 100,
  maxOptionSpreadFraction: .2,
  maxQuoteAgeMs: 5000,
  maxObservationGapMs: 5000,
  pollMs: 1000,
  includePremarketLeadMinutes: input.includePremarketLeadMinutes,
  entryWindowMinutes: input.entryWindowMinutes ?? ENTRY_WINDOW_MINUTES.default,
});
