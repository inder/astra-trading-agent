// The opening-range strategy's rules, each written once. The engine, the paper runtime's view and the replay harness
// call these; none of them restates a rule. A rule returns its decision with the observation behind it, so a caller
// can record why it fired. A new rule is a new function here plus its settings row in orb-options.ts SETTINGS.

/** The part of an opening range a rule reads. */
export interface RangeLevels { high: number; low: number }
/** One rule's answer: whether it fired, its journaled name, and the observation behind it. */
export interface RuleDecision<R extends string = string> { fired: boolean; reason: R; evidence: Record<string, unknown> }

/** Entry trigger: a price above the opening-range high. */
export function breakoutAbove(price: number, range: RangeLevels): RuleDecision<"breakout"> {
  return { fired: price > range.high, reason: "breakout", evidence: { price, rangeHigh: range.high } };
}

/** Before entry: a price beneath the opening-range low ends the day for this stock, even if it later rallies. */
export function openingLowBroken(price: number, range: RangeLevels): RuleDecision<"opening_low_failed"> {
  return { fired: price < range.low, reason: "opening_low_failed", evidence: { price, rangeLow: range.low } };
}

/** The stock price under which the protective stop sells: a buffer beneath the opening-range low. */
export function protectiveStopLevel(range: RangeLevels, bufferFraction: number): number {
  return range.low * (1 - bufferFraction);
}
/** After entry, before the first target: a price beneath the protective stop level sells everything. */
export function protectiveStopHit(price: number, level: number): RuleDecision<"protective_stop"> {
  return { fired: price < level, reason: "protective_stop", evidence: { price, stopLevel: level } };
}
/** After the first target: the stock back at or below its entry price sells the rest. */
export function breakevenStopHit(price: number, entryStockPrice: number): RuleDecision<"breakeven_stop"> {
  return { fired: price <= entryStockPrice, reason: "breakeven_stop", evidence: { price, entryStockPrice } };
}
