import type { DailyBars } from "../src/levels.ts";

/** One invented year of daily bars, built so the answers are known before the engine runs, and identical on every
 *  machine: a rising channel (its lows make a support line, its highs a falling-back resistance), a shelf the price
 *  tests three times and breaks, an unfilled gap up early (support) and an unfilled gap down late (resistance).
 *  Not market data: every price here is arithmetic. */
export function syntheticBars(): DailyBars {
  const time: string[] = [], open: number[] = [], high: number[] = [], low: number[] = [], close: number[] = [];
  const day = 86400000; let cursor = Date.parse("2025-09-15T00:00:00Z");
  const push = (o: number, h: number, l: number, c: number) => {
    while ([0, 6].includes(new Date(cursor).getUTCDay())) cursor += day;   // weekdays only, no holidays
    time.push(new Date(cursor).toISOString().slice(0, 10)); cursor += day;
    open.push(round(o)); high.push(round(h)); low.push(round(l)); close.push(round(c));
  };
  const round = (v: number) => Math.round(v * 100) / 100;
  // A 40-bar cycle inside a rising channel: 20 bars up, 20 down, each cycle 4 higher than the last.
  const wave = (i: number) => { const p = i % 40; return p < 20 ? p * 0.6 : (40 - p) * 0.6; };
  let base = 100;
  for (let i = 0; i < 120; i++) {
    const mid = base + wave(i) + i * 0.05;
    push(mid - 0.3, mid + 0.9, mid - 1.1, mid + 0.2);
  }
  // A gap up that never fills: every later low stays above the prior high.
  base += 9;
  for (let i = 120; i < 200; i++) {
    const mid = base + wave(i) + i * 0.05;
    push(mid, mid + 1.1, mid - 0.8, mid + 0.3);
  }
  // A shelf: three pushes into the same price that close back below it, then a break above.
  const shelf = base + 9 + 200 * 0.05;
  for (let i = 200; i < 236; i++) {
    const near = [204, 216, 228].some(x => Math.abs(i - x) <= 1);
    const mid = near ? shelf - 0.8 : shelf - 3 - ((i % 6) * 0.4);
    push(mid - 0.2, near ? shelf + 0.15 : mid + 0.7, mid - 0.9, near ? shelf - 0.6 : mid + 0.1);
  }
  for (let i = 236; i < 248; i++) { const mid = shelf + 1.5 + (i - 236) * 0.5; push(mid - 0.4, mid + 0.8, mid - 0.7, mid + 0.4); }
  // A gap down that never fills: every later high stays below the prior low, leaving resistance overhead.
  const before = low[low.length - 1]!;
  for (let i = 248; i < 258; i++) {
    const mid = before - 4.5 - (i - 248) * 0.25;
    push(mid + 0.2, mid + 0.9, mid - 0.6, mid - 0.1);
  }
  return { time, open, high, low, close };
}

/** A second invented year, falling: each rally stops lower, so the highs make a down-trend line to be found, with a
 *  base the lows keep returning to. The mirror of the series above, so both trend directions are exercised. */
export function syntheticDowntrendBars(): DailyBars {
  const time: string[] = [], open: number[] = [], high: number[] = [], low: number[] = [], close: number[] = [];
  const day = 86400000; let cursor = Date.parse("2025-09-15T00:00:00Z");
  const round = (v: number) => Math.round(v * 100) / 100;
  const push = (o: number, h: number, l: number, c: number) => {
    while ([0, 6].includes(new Date(cursor).getUTCDay())) cursor += day;
    time.push(new Date(cursor).toISOString().slice(0, 10)); cursor += day;
    open.push(round(o)); high.push(round(h)); low.push(round(l)); close.push(round(c));
  };
  const wave = (i: number) => { const p = i % 40; return p < 20 ? p * 0.5 : (40 - p) * 0.5; };
  for (let i = 0; i < 240; i++) {
    const mid = 200 - i * 0.1 + wave(i);           // rallies that each stop lower
    push(mid - 0.4, mid + 0.8, Math.max(mid - 1.2, 175), mid - 0.1);   // the lows keep finding one base
  }
  return { time, open, high, low, close };
}
