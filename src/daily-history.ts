// Exchange calendar deliberately bounded to this experiment's 2026 support.
// https://www.nasdaq.com/market-activity/stock-market-holiday-schedule
const HOLIDAYS = new Set(["2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25"]);
export function isTradingDay(date: string): boolean {
  const d = new Date(date + "T00:00:00Z");
  return /^2026-\d\d-\d\d$/.test(date) && Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === date && d.getUTCDay() !== 0 && d.getUTCDay() !== 6 && !HOLIDAYS.has(date);
}
