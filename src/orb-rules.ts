// The opening-range strategy's rules, each written once. The engine, the paper runtime's view and the replay harness
// call these; none of them restates a rule. A rule returns its decision with the evidence the journal records, so a
// review can see why it fired. A new rule is a new function here plus its settings row in orb-options.ts SETTINGS.

/** The part of an opening range a rule reads. */
export interface RangeLevels { high: number; low: number }
/** One rule's answer: whether it fired, its journaled name, and the observation behind it. */
export interface RuleDecision<R extends string = string> { fired: boolean; reason: R; evidence: Record<string, unknown> }
const iso = (ms: number | null) => ms === null ? null : new Date(ms).toISOString();
/** Levels are journaled to 1/10,000 of a dollar, never with float noise (122.78, not 122.77999999999999). */
const shown = (v: number) => Math.round(v * 1e4) / 1e4;

/** Entry trigger: a trade above the opening-range high. */
export function breakoutAbove(price: number, range: RangeLevels): RuleDecision<"breakout"> {
  return { fired: price > range.high, reason: "breakout", evidence: { price, rangeHigh: range.high } };
}

// ---- Candles. Fixed grid from the end of the opening range: [end, end+m), [end+m, end+2m), ... (founder: candles
// start at the open, never rolling). With the default 2-minute candles and 2-minute range this is the grid from 9:30.

/** A finished candle. `close` is the last OBSERVED trade before its end (Astra polls; this is not the exchange's
 *  official close), or null when Astra was not watching closely enough to know it. */
export interface CandleClose { start: number; end: number; close: number | null; closeTradeAt: number | null }
/** What a stock's candle builder remembers between observations. */
export interface CandleState { nextEnd: number; lastPrice: number | null; lastTradeMs: number | null; lastObservedMs: number | null }
export const newCandleState = (gridStart: number, minutes: number): CandleState =>
  ({ nextEnd: gridStart + minutes * 60000, lastPrice: null, lastTradeMs: null, lastObservedMs: null });
/** Feed one observed trade (price, its trade time, when Astra fetched it); returns the candles it finishes, in order.
 *  A candle ends at B once a trade at or after B is seen (the feed is in time order) or, for a quiet stock, once a fetch
 *  lands settleMs past B: the most a fresh quote may lag, so a late-arriving trade from before B is still counted. Its
 *  close is the latest trade before B: this trade when it printed before B, else the one held from before, but only if
 *  Astra last saw a FRESH quote within maxGapMs of B. Otherwise the close is unknown and no rule may act on it: an
 *  unseen path is never inferred. A stale quote (fresh = false) can finish candles but never vouches for a close: a
 *  quiet stock and a frozen feed look the same from here. */
export function observeCandles(state: CandleState, price: number, tradeMs: number, observedMs: number,
  minutes: number, settleMs: number, maxGapMs: number, fresh = true): CandleClose[] {
  if (state.lastObservedMs !== null && observedMs < state.lastObservedMs) return [];
  const length = minutes * 60000, newer = state.lastTradeMs === null || tradeMs > state.lastTradeMs, closes: CandleClose[] = [];
  for (;;) {
    const end = state.nextEnd;
    if (!((newer && tradeMs >= end) || observedMs >= end + settleMs)) break;
    let close: number | null = null, closeTradeAt: number | null = null;
    if (newer && tradeMs < end) { close = price; closeTradeAt = tradeMs; }
    else if (state.lastTradeMs !== null && state.lastTradeMs < end && state.lastObservedMs !== null && end - state.lastObservedMs <= maxGapMs) {
      close = state.lastPrice; closeTradeAt = state.lastTradeMs;
    }
    closes.push({ start: end - length, end, close, closeTradeAt });
    state.nextEnd = end + length;
  }
  if (newer) { state.lastPrice = price; state.lastTradeMs = tradeMs; }
  if (fresh) state.lastObservedMs = observedMs;
  return closes;
}
/** The same candles from minute bars (the replay's reference): a candle's close is its last minute bar's close. */
export function barCandleCloses(bars: readonly { at: number; close: number }[], gridStart: number, minutes: number): CandleClose[] {
  const length = minutes * 60000, last = new Map<number, { at: number; close: number }>();
  for (const b of bars) {
    if (b.at < gridStart) continue;
    const end = gridStart + (Math.floor((b.at - gridStart) / length) + 1) * length, held = last.get(end);
    if (!held || b.at > held.at) last.set(end, b);
  }
  // A candle counts only once its last minute is in: a partial final candle has no close yet.
  return [...last].filter(([end, b]) => b.at === end - 60000).sort(([a], [b]) => a - b)
    .map(([end, b]) => ({ start: end - length, end, close: b.close, closeTradeAt: b.at }));
}
const candleEvidence = (c: CandleClose) => ({ candleStart: iso(c.start), candleEnd: iso(c.end), observedClose: c.close, closeTradeAt: iso(c.closeTradeAt) });

// ---- Cancel: what ends a stock's setup before entry (founder, 2026-10-04).

/** The price a candle must close beneath to cancel the setup: the range low minus `tolerance` range heights. */
export function cancelLevel(range: RangeLevels, tolerance: number): number {
  return range.low - tolerance * (range.high - range.low);
}
/** Before entry: a candle closing beneath the cancel level ends the day for this stock, even if it later rallies. A
 *  wick, a single print or a dip that recovers before the candle ends does not. */
export function setupCancelled(candle: CandleClose, range: RangeLevels, tolerance: number): RuleDecision<"opening_low_failed"> {
  const level = cancelLevel(range, tolerance);
  return { fired: candle.close !== null && candle.close < level, reason: "opening_low_failed",
    evidence: { ...candleEvidence(candle), cancelLevel: shown(level), rangeLow: range.low, rangeHigh: range.high, toleranceRanges: tolerance } };
}

// ---- Protective stop: from entry until the position is closed (founder, 2026-10-04; the breakeven stop is gone).

/** The low the stop sits under: the lowest of the opening range's low and every price seen from the range's end through
 *  the entry (observed trades, and minute-bar lows when they could be read). Fixed at entry. */
export function stopAnchor(rangeLow: number, ...lows: (number | null)[]): number {
  return Math.min(rangeLow, ...lows.filter((v): v is number => v !== null && Number.isFinite(v) && v > 0));
}
export function protectiveStopLevel(anchor: number, bufferFraction: number): number {
  return anchor * (1 - bufferFraction);
}
/** After entry: a candle closing beneath the stop level sells everything. */
export function protectiveStopHit(candle: CandleClose, level: number, anchor: number): RuleDecision<"protective_stop"> {
  return { fired: candle.close !== null && candle.close < level, reason: "protective_stop",
    evidence: { ...candleEvidence(candle), stopLevel: shown(level), stopAnchor: anchor } };
}

// ---- Context, journaled but read by no rule (yet): the opening range against the stock's normal daily movement.

/** ATR as the levels engine measures it: the mean of the last `n` true ranges, from daily bars strictly before the
 *  trade date (all known at the open). null when there are not `n` + 1 sessions. */
export function trailingAtr(bars: readonly { high: number; low: number; close: number }[], n = 14): number | null {
  if (bars.length < n + 1) return null;
  const tr = bars.slice(-n).map((b, i) => { const prev = bars[bars.length - n - 1 + i]!.close; return Math.max(b.high - b.low, Math.abs(b.high - prev), Math.abs(b.low - prev)); });
  const atr = tr.reduce((a, b) => a + b, 0) / n;
  return atr > 0 ? atr : null;
}
/** The opening range as a share of that ATR (0.5 = the first two minutes moved half a normal day). */
export function rangeVsAtr(range: RangeLevels, atr: number | null): { atr14: number | null; rangeToAtr: number | null } {
  return { atr14: atr === null ? null : shown(atr), rangeToAtr: atr === null ? null : Math.round((range.high - range.low) / atr * 1000) / 1000 };
}
