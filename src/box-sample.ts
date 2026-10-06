// The support-box strategy's synthetic sample: invented candles run through the same pure scanner the live run uses. It is
// a demonstration of the rules and their journal, not market data and not a result.
import { scanBoxes, type Candle, type Support } from "./box-rules.ts";
import { sessionTimes } from "./daily-history.ts";
import { OPENING_RANGE_MINUTES } from "./orb-options.ts";
import type { BoxConfig } from "./box-settings.ts";

/** Invented 2-minute candles as (open, high, low, close) from 9:32 ET: a pull-back, a tight contracting box, a close above it. */
const SPECS: readonly (readonly [number, number, number, number])[] = [
  [100.9, 101.5, 100.4, 100.6], [100.6, 101.0, 100.1, 100.3], [100.3, 100.7, 99.7, 100.0], [100.0, 100.4, 99.3, 99.8], [99.8, 100.2, 99.1, 99.7],
  [99.7, 100.0, 97.4, 99.4],
  [99.5, 100.0, 99.1, 99.4], [99.4, 99.95, 99.05, 99.8], [99.8, 100.0, 99.1, 99.5], [99.5, 99.95, 99.05, 99.7], [99.7, 100.0, 99.1, 99.4], [99.4, 99.95, 99.1, 99.8],
  [99.8, 99.95, 99.55, 99.6], [99.6, 99.9, 99.5, 99.7], [99.7, 99.95, 99.55, 99.6], [99.6, 99.9, 99.5, 99.7], [99.7, 99.9, 99.5, 99.6], [99.6, 99.9, 99.5, 99.8],
  [99.8, 99.95, 99.55, 99.7], [99.7, 100.6, 99.6, 100.4],
];
export function boxSample(config: BoxConfig) {
  const grid = sessionTimes(config.date).open + OPENING_RANGE_MINUTES * 60000, length = config.candleMinutes * 60000;
  const candles: Candle[] = SPECS.map(([, high, low, close], i) => ({ start: grid + i * length, end: grid + (i + 1) * length, high, low, close }));
  const atr = 8, supports: Support[] = [{ kind: "anchored_vwap", label: "invented anchored VWAP", lo: 99.0, hi: 99.0 }];
  const boxes = scanBoxes(candles, () => supports, atr, config);
  const symbol = config.symbols[0]!;
  const events = [{ type: "sample_started", data: { dataset: "synthetic-box-v1", marketDate: config.date, ordersSubmitted: 0, positions: 0, atr14: atr, supports } },
    ...boxes.map(b => ({ type: `box_${b.status}`, data: { symbol, synthetic: true, ...b } })),
    { type: "sample_completed", data: { dataset: "synthetic-box-v1", ordersSubmitted: 0, positions: 0, boxes: boxes.length } }];
  const summary = { mode: "synthetic_sample", dataset: "synthetic-box-v1", ordersSubmitted: 0, positions: 0, pnl: null, pnlExplanation: "Watch-only: this strategy opens no positions.",
    boxes, limitations: ["Invented candles, ATR and support; not market data.", "Exercises the box, contraction, support, decision and journaled entry levels; not broker or data validation.",
      "Watch-only: no position, fill or order exists in this version."] };
  return { events: events.map((e, i) => ({ sequence: i + 1, ...e })), summary };
}
