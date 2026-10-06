// Invented data shaped like the founder's examples (SOXL, RKT, IBM on 2026-10-05). None of it is market data.
import { addDays, isTradingDay, sessionTimes } from "../src/daily-history.ts";
import type { DailyBars } from "../src/levels.ts";
import type { BoxBar } from "../src/box-rules.ts";

export const DAY = "2026-10-05";
/** The `count` trading days ending on `last`, oldest first. */
export function sessionsEnding(last: string, count: number): string[] {
  const out: string[] = [];
  for (let d = last; out.length < count; d = addDays(d, -1)) if (isTradingDay(d)) out.unshift(d);
  return out;
}
const round = (v: number) => Math.round(v * 100) / 100;
/** Daily bars from a path of closes: each bar opens at the previous close and wicks `wick(i)` past its body. */
function fromCloses(dates: string[], closes: number[], wick: (i: number) => number, start: number): DailyBars {
  const bars: DailyBars = { time: dates, open: [], high: [], low: [], close: [] };
  closes.forEach((c, i) => {
    const o = i === 0 ? start : closes[i - 1]!, w = wick(i);
    bars.open.push(round(o)); bars.close.push(round(c)); bars.high.push(round(Math.max(o, c) + w)); bars.low.push(round(Math.min(o, c) - w));
  });
  return bars;
}
/** A runaway: a 95-session range whose ceiling (about 120) is touched again and again, a quiet drift under it, then a
 *  fast climb that closes through the ceiling and keeps going. Ends the session before DAY, with a daily range near 11. */
export function runawayDailies(): DailyBars {
  const dates = sessionsEnding("2026-10-02", 125), closes: number[] = [];
  for (let i = 0; i < 95; i++) closes.push(i % 15 === 7 ? 118.5 : 100 + 12 * Math.abs(Math.sin(i * Math.PI / 15)));
  for (let i = 0; i < 21; i++) closes.push(110 + (i % 5));
  closes.push(...[118, 126, 133, 139, 145, 151, 158, 162, 165]);
  return fromCloses(dates, closes, i => i < 95 ? 1 : i < 116 ? 1.5 : 4.6, 100);
}
/** A stock that is not a runaway (RKT, IBM): below every average, drifting down, nothing broken. */
export function laggardDailies(): DailyBars {
  const dates = sessionsEnding("2026-10-02", 125), closes: number[] = [];
  for (let i = 0; i < 125; i++) closes.push(round(60 - i * 0.12 + 3 * Math.sin(i / 4)));
  return fromCloses(dates, closes, () => 0.8, 60);
}

/** One 2-minute candle as (open, high, low, close). */
export type Spec = readonly [number, number, number, number];
const BAR = (at: number, o: number, h: number, l: number, c: number, volume = 1000): BoxBar =>
  ({ begins_at: new Date(at).toISOString(), open_price: String(o), high_price: String(h), low_price: String(l), close_price: String(c), volume: String(volume) });
/** Two minute bars that together make one candle with exactly these extremes. */
export function candleBars(start: number, [o, h, l, c]: Spec): BoxBar[] {
  const mid = (o + c) / 2;
  return [BAR(start, o, h, Math.min(o, mid), mid), BAR(start + 60000, mid, Math.max(c, mid), l, c)];
}
/** A flat session of real-looking bars (every regular minute, volume 1000) at one typical price: only its VWAP matters. */
export function flatSession(date: string, typical: number): BoxBar[] {
  const { open, close } = sessionTimes(date);
  return Array.from({ length: (close - open) / 60000 }, (_, i) => BAR(open + i * 60000, typical, typical + 0.1, typical - 0.1, typical));
}
/** The 9:32-onward candles of the reference day, by their start time (minutes after 9:30). Invented, shaped like SOXL on
 *  2026-10-05: a pull-back to support, a tight box that contracts (and holds a double bottom), a first close above it. */
export const PRE_BOX: Spec[] = [
  [162.2, 163.4, 161.8, 161.9], [161.9, 162.9, 161.0, 161.3], [161.3, 162.2, 160.5, 160.7], [160.7, 161.3, 159.9, 160.1], [160.1, 160.6, 159.3, 159.5],
  [159.5, 160.1, 158.9, 159.2], [159.2, 159.8, 156.9, 158.3]];   // 9:32 .. 9:44; the last is a flush to support
export const BOX_FIRST_HALF: Spec[] = [
  [159.0, 159.35, 158.15, 158.9], [158.9, 160.0, 158.9, 159.8], [159.8, 160.22, 159.0, 159.3],
  [159.3, 159.9, 158.75, 159.5], [159.5, 159.95, 158.85, 159.1], [159.1, 159.9, 158.75, 159.6]];  // 9:44 .. 9:54
export const BOX_SECOND_HALF: Spec[] = [
  [159.6, 159.7, 158.8, 158.9], [158.6, 158.93, 158.08, 158.7], [158.7, 159.5, 158.65, 159.3],
  [159.3, 159.9, 159.05, 159.4], [159.4, 159.85, 159.0, 159.5], [159.5, 159.9, 159.1, 159.6]];     // 9:56 .. 10:06
export const INSIDE_AFTER: Spec[] = [[159.6, 159.9, 159.3, 159.5]];       // 10:08, closes inside the box
export const BREAKOUT: Spec[] = [[159.6, 160.9, 159.5, 160.71]];           // 10:10..10:12, first close above (ends 10:12)
export const RUN_AFTER: Spec[] = [[160.7, 162.6, 160.6, 162.4], [162.4, 164.38, 162.2, 164.0], [164.0, 164.2, 162.0, 162.8], [162.8, 164.3, 162.5, 164.27]];
export interface DayOptions { pre?: Spec[]; first?: Spec[]; second?: Spec[]; inside?: Spec[]; breakout?: Spec[]; after?: Spec[]; priorTypical?: [number, number, number]; drop?: number[] }
/** The reference day's minute bars plus the three sessions before it. `drop` removes the minute bars at those candle
 *  indexes' first minute (a candle missing a minute has no known close). */
export function referenceBars(o: DayOptions = {}): BoxBar[] {
  const { open } = sessionTimes(DAY), grid = open + 120000, specs = [...(o.pre ?? PRE_BOX), ...(o.first ?? BOX_FIRST_HALF), ...(o.second ?? BOX_SECOND_HALF),
    ...(o.inside ?? INSIDE_AFTER), ...(o.breakout ?? BREAKOUT), ...(o.after ?? RUN_AFTER)];
  const today = [BAR(open, 162, 162.4, 161.8, 162.2), BAR(open + 60000, 162.2, 162.2, 161.8, 161.9),
    ...specs.flatMap((s, i) => candleBars(grid + i * 120000, s).filter((_, m) => !(o.drop?.includes(i) && m === 0)))];
  const [a, b, c] = o.priorTypical ?? [150, 154, 162];
  return [...flatSession("2026-09-30", a), ...flatSession("2026-10-01", b), ...flatSession("2026-10-02", c), ...today];
}
