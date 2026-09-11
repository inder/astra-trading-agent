// NYSE equity calendar from the exchange's published schedule (https://www.nyse.com/markets/hours-calendars;
// 2027 verified 2026-09-10). Extend SUPPORTED_YEARS and both tables together. A weekday outside the covered
// years is unknown, not closed: code that needs one gets a CalendarCoverageError instead of a silent guess.
export const SUPPORTED_YEARS = [2026, 2027] as const;
const HOLIDAYS = new Set([
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
]);
const EARLY_CLOSES = new Set(["2026-11-27", "2026-12-24", "2027-11-26"]); // 1:00 p.m. ET
export class CalendarCoverageError extends Error { name = "CalendarCoverageError"; }

const parse = (date: string) => {
  const d = new Date(date + "T00:00:00Z");
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === date ? d : null;
};
const weekday = (date: string) => new Date(date + "T00:00:00Z").getUTCDay();
export const addDays = (date: string, days: number) => new Date(Date.parse(date + "T00:00:00Z") + days * 86400000).toISOString().slice(0, 10);
export function calendarCovers(date: string): boolean {
  const d = parse(date); return !!d && (SUPPORTED_YEARS as readonly number[]).includes(d.getUTCFullYear());
}
export function isTradingDay(date: string): boolean {
  return calendarCovers(date) && weekday(date) !== 0 && weekday(date) !== 6 && !HOLIDAYS.has(date);
}
export function isEarlyClose(date: string): boolean { return isTradingDay(date) && EARLY_CLOSES.has(date); }
/** Regular-session open and close (epoch ms) for a covered trading day, 9:30 ET to 4:00 ET (1:00 on early closes). */
export function sessionTimes(date: string) {
  if (!isTradingDay(date)) throw new Error("Unsupported market session");
  const noon = Date.parse(date + "T12:00:00Z");
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hourCycle: "h23" }).format(noon));
  const open = Date.parse(date + "T00:00:00Z") + (9.5 + 12 - hour) * 3600000;
  return { open, close: open + (isEarlyClose(date) ? 3.5 : 6.5) * 3600000 };
}
// Weekends need no calendar; an uncovered weekday throws rather than being treated as a holiday.
function tradingDayKnown(date: string): boolean {
  if (!parse(date)) throw new Error("Invalid calendar date");
  if (weekday(date) === 0 || weekday(date) === 6) return false;
  if (!calendarCovers(date)) throw new CalendarCoverageError(`Exchange calendar does not cover ${date.slice(0, 4)}`);
  return isTradingDay(date);
}
/** Inclusive count of trading sessions from `from` through `to`. */
export function tradingSessionsBetween(from: string, to: string): number {
  if (!parse(from) || !parse(to) || to < from) throw new Error("Invalid session range");
  let count = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) if (tradingDayKnown(d)) count++;
  return count;
}
/** A trading day with no later trading day in its Monday–Sunday week: normally Friday, or Thursday before a Friday holiday. */
export function isWeekEnder(date: string): boolean {
  if (!tradingDayKnown(date)) return false;
  for (let d = addDays(date, 1); weekday(d) !== 1; d = addDays(d, 1)) if (tradingDayKnown(d)) return false;
  return true;
}
