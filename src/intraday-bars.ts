import { addDays, calendarCovers, isTradingDay, sessionTimes } from "./daily-history.ts";
import { timestamp } from "./validation.ts";

/** One regular-session minute, as the chart and the store hold it: epoch ms of the minute's left edge, prices in
 *  dollars, shares traded. */
export interface MinuteBar { t: number; o: number; h: number; l: number; c: number; v: number }

/** Regular-session minute bars for one stock, oldest first.
 *
 *  Built against captured replies (test/fixtures/robinhood-minute-*.json, RDDT 2026-10-02), not the test fakes, which
 *  had `volume` as a string; Robinhood sends a number. Bars are labelled by their left edge in UTC.
 *
 *  Dropped, not thrown on: `interpolated: true` bars, which Robinhood's own guidance calls gap-fill that "carry no new
 *  info and should usually be hidden in charts" — a minute nobody traded in, copied from the last price. The key is
 *  present only on those bars. Bars from outside the regular session are dropped too, so a chart asked for regular
 *  bounds can never show a pre-market print as if it were a session candle.
 *
 *  The series as a whole is still refused when its structure is wrong, as the daily parser does. */
export function normalizeMinuteBars(raw: unknown, symbol: string): MinuteBar[] {
  const results = (raw as any)?.data?.results;
  const matches = Array.isArray(results) ? results.filter((r: any) => r?.symbol === symbol) : [];
  if (matches.length !== 1 || matches[0]?.interval !== "minute" || !Array.isArray(matches[0]?.bars)) throw new Error("Minute bars unavailable");
  const out: MinuteBar[] = [];
  for (const bar of matches[0].bars) {
    if (bar?.interpolated === true || (bar?.session !== undefined && bar.session !== "reg")) continue;
    const t = timestamp(typeof bar?.begins_at === "string" ? bar.begins_at : null);
    if (!Number.isFinite(t) || t % 60000 !== 0) continue;
    const [o, h, l, c] = [bar.open_price, bar.high_price, bar.low_price, bar.close_price].map(Number) as [number, number, number, number];
    if (![o, h, l, c].every(v => Number.isFinite(v) && v > 0) || h < l || o > h || o < l || c > h || c < l) continue;
    const v = Number(bar.volume ?? 0);
    if (out.length && t <= out.at(-1)!.t) throw new Error("Minute bars are out of order");
    out.push({ t, o, h, l, c, v: Number.isFinite(v) && v >= 0 ? Math.round(v) : 0 });
  }
  return out;
}

export interface Session { date: string; open: number; close: number }
/** The covered trading sessions from `count` sessions back through `through`, oldest first. A date the exchange
 *  calendar does not cover ends the walk rather than being guessed at. */
export function sessionsThrough(through: string, count: number): Session[] {
  const out: Session[] = [];
  for (let d = through; out.length < count && calendarCovers(d); d = addDays(d, -1))
    if (isTradingDay(d)) out.unshift({ date: d, ...sessionTimes(d) });
  return out;
}

/** The longest span one minute-history read may cover. Captured 2026-10-04: a Monday-to-Friday window (4.3 days of
 *  wall clock) returned 1,950 bars; a 30-day window failed outright. The real limit lies somewhere between, and is not
 *  worth an approval round-trip to find: five days is known to work. */
export const MAX_MINUTE_WINDOW_MS = 5 * 86400000;
/** Reads that cover `sessions`, each within MAX_MINUTE_WINDOW_MS. Sessions stay in order and none is split. When
 *  `all` is given, a window joins only sessions adjacent in it, so a read never spans a session already held. */
export function minuteWindows(sessions: Session[], all: Session[] = sessions): { start: number; end: number }[] {
  const windows: { start: number; end: number }[] = [];
  const position = new Map(all.map((s, i) => [s.date, i]));
  let previous: Session | undefined;
  for (const s of sessions) {
    const last = windows.at(-1);
    const adjacent = previous !== undefined && position.get(s.date)! - position.get(previous.date)! === 1;
    if (last && adjacent && s.close - last.start <= MAX_MINUTE_WINDOW_MS) last.end = s.close;
    else windows.push({ start: s.open, end: s.close });
    previous = s;
  }
  return windows;
}
