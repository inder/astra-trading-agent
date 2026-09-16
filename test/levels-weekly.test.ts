import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateWeekly, levels, movingAverageSeries, parseLevelsSettings, windowStart,
  DAILY_TIMEFRAMES, TIMEFRAMES, type DailyBars } from "../src/levels.ts";
import { syntheticBars } from "./levels-fixture.ts";

const bars = syntheticBars();
// Monday 5 January 2026 onwards, one bar per weekday, so week boundaries are known by construction.
function weekdays(count: number, from = "2026-01-05", price = (i: number) => 100 + i): DailyBars {
  const out: DailyBars = { time: [], open: [], high: [], low: [], close: [] };
  let day = Date.parse(`${from}T00:00:00Z`);
  while (out.time.length < count) {
    const date = new Date(day).toISOString().slice(0, 10), weekday = new Date(day).getUTCDay();
    day += 86400000;
    if (weekday === 0 || weekday === 6) continue;
    const i = out.time.length, p = price(i);
    out.time.push(date); out.open.push(p); out.high.push(p + 1); out.low.push(p - 1); out.close.push(p + 0.5);
  }
  return out;
}

test("daily bars fold into weeks dated by their Monday, with the week's own open, extremes and last close", () => {
  const two = weekdays(10);                                   // Mon 5 Jan through Fri 16 Jan
  const weeks = aggregateWeekly(two, "2026-01-16");
  assert.deepEqual(weeks.time, ["2026-01-05", "2026-01-12"]);
  assert.equal(weeks.open[0], two.open[0], "the week opens where Monday opened");
  assert.equal(weeks.close[0], two.close[4], "and closes where Friday closed");
  assert.equal(weeks.high[0], Math.max(...two.high.slice(0, 5)));
  assert.equal(weeks.low[0], Math.min(...two.low.slice(0, 5)));
  // Real quotes carry cents tails, and the fold must carry them through untouched rather than round anything.
  const uneven = weekdays(10, "2026-01-05", i => 100 + i * 0.0137);
  const odd = aggregateWeekly(uneven, "2026-01-16");
  assert.equal(odd.high[0], Math.max(...uneven.high.slice(0, 5)));
  assert.equal(odd.low[0], Math.min(...uneven.low.slice(0, 5)));
  assert.equal(odd.close[1], uneven.close[9], "the week's close is the last session's, to the cent");
  assert.ok(String(odd.close[1]).includes("."), "and it is not a round number");
});
test("the settled date, not the last bar, decides a week is over — so a holiday Friday does not hide a full week", () => {
  // Good Friday 2027 is 26 March: the week of the 22nd has no Friday session, and judging it by its own last bar
  // would drop a complete week until Tuesday. levels() is handed the settled date for exactly this reason, and the
  // service's settled date advances through weekends and holidays.
  const bars: DailyBars = { time: [], open: [], high: [], low: [], close: [] };
  for (const d of ["2027-03-15", "2027-03-16", "2027-03-17", "2027-03-18", "2027-03-19",
    "2027-03-22", "2027-03-23", "2027-03-24", "2027-03-25"]) {
    bars.time.push(d); bars.open.push(10); bars.high.push(11); bars.low.push(9); bars.close.push(10.5);
  }
  assert.deepEqual(aggregateWeekly(bars, "2027-03-25").time, ["2027-03-15"], "mid-week, the week is still forming");
  assert.deepEqual(aggregateWeekly(bars, "2027-03-26").time, ["2027-03-15", "2027-03-22"], "on the holiday, it is over");
  assert.deepEqual(aggregateWeekly(bars, "2027-03-28").time, ["2027-03-15", "2027-03-22"], "and stays over");
});
test("a week still trading is left out until it is over, the same rule the daily reader applies to today", () => {
  const partial = weekdays(8);                                 // two full weeks' worth of bars, ending Wednesday
  assert.equal(partial.time.at(-1), "2026-01-14");
  assert.deepEqual(aggregateWeekly(partial, "2026-01-14").time, ["2026-01-05"], "Wednesday's week is not a week yet");
  assert.deepEqual(aggregateWeekly(weekdays(10), "2026-01-16").time.length, 2, "once Friday settles, it counts");
  // A week whose Friday never traded is counted from the following Monday rather than left out forever.
  const holidayWeek = weekdays(9);                             // ends Thursday 15 Jan
  assert.deepEqual(aggregateWeekly(holidayWeek, "2026-01-15").time, ["2026-01-05"], "Thursday alone is not the week");
  assert.deepEqual(aggregateWeekly(holidayWeek, "2026-01-19").time, ["2026-01-05", "2026-01-12"], "past it, it counts");
});
test("weeks survive month and year ends, and a single-session week is still a week", () => {
  const acrossNewYear = weekdays(12, "2026-12-28");            // Mon 28 Dec 2026 into January 2027
  const weeks = aggregateWeekly(acrossNewYear, "2027-01-15");
  assert.ok(weeks.time.includes("2026-12-28") && weeks.time.includes("2027-01-04"), "the turn of the year splits weeks");
  assert.ok(weeks.time.every((w, i) => i === 0 || w > weeks.time[i - 1]!), "weeks run forward");
  const oneDay: DailyBars = { time: ["2026-01-08"], open: [10], high: [11], low: [9], close: [10.5] };
  assert.deepEqual(aggregateWeekly(oneDay, "2026-01-09"), { time: ["2026-01-05"], open: [10], high: [11], low: [9], close: [10.5] });
});
test("windowStart names every timeframe and refuses one it does not know", () => {
  assert.equal(windowStart("2026-09-09", "5y"), "2021-09-09");
  assert.equal(windowStart("2026-09-09", "5y", parseLevelsSettings({ weeklyYears: 3 })), "2023-09-09");
  assert.equal(windowStart("2026-09-09", "2y"), "2024-09-09");
  // The old fallthrough handed any unknown timeframe the 2-year window under its own name.
  assert.throws(() => windowStart("2026-09-09", "10y" as never), /Unknown timeframe/);
});
test("the weekly frame is opt-in, is labelled weekly, and never becomes the default answer", () => {
  const daily = levels(bars, parseLevelsSettings());
  assert.deepEqual(daily.frames.map(f => f.timeframe), DAILY_TIMEFRAMES, "a written answer stays daily");
  assert.deepEqual(TIMEFRAMES.at(-1), "5y", "but weekly is a valid timeframe to ask for");
  const withWeekly = levels(bars, parseLevelsSettings({ timeframes: [...DAILY_TIMEFRAMES, "5y"] }));
  const week = withWeekly.frames.find(f => f.timeframe === "5y")!;
  assert.equal(week.bar, "week"); assert.equal(week.label, "5 years (weekly)");
  assert.ok(withWeekly.frames.filter(f => f.timeframe !== "5y").every(f => f.bar === "day"));
  // The bug this guards: defaultTimeframe took the longest frame, so weekly would have answered every question.
  assert.equal(withWeekly.defaultTimeframe, "2y");
  assert.ok(week.sessions < daily.sessions / 4, `weeks, not sessions: ${week.sessions} from ${daily.sessions} bars`);
});
test("a weekly frame measures weekly movement and splits at the price the answer reports", () => {
  const got = levels(bars, parseLevelsSettings({ timeframes: ["2y", "5y"] }));
  const week = got.frames.find(f => f.timeframe === "5y")!, day = got.frames.find(f => f.timeframe === "2y")!;
  if (week.unavailable) return assert.fail(`weekly frame unavailable: ${week.unavailable}`);
  assert.ok(week.atr! > day.atr!, "a week moves further than a day");
  for (const z of week.support!) assert.ok(z.hi < got.price, `${z.id} sits below the reported price`);
  for (const z of week.resistance!) assert.ok(z.lo > got.price, `${z.id} sits above the reported price`);
  for (const z of [...week.support!, ...week.resistance!]) assert.ok(z.hi - z.lo <= week.width! + 1e-9);
});
test("the weekly frame judges trend lines by its own rules, not the daily ones", () => {
  // Weekly bars swing several times as far as daily ones, so the daily allowance (10 ATR) would call a line most of
  // the way to zero "near the price". The weekly settings are separate for that reason.
  const settings = parseLevelsSettings({ timeframes: ["5y"] });
  assert.equal(settings.weeklyTrendMaxDistanceAtr, 3);
  assert.equal(settings.weeklyTrendMinBars, 12);
  assert.ok(settings.trendMaxDistanceAtr > settings.weeklyTrendMaxDistanceAtr, "and they are tighter than the daily ones");
  assert.ok(settings.weeklyTrendMinBars > settings.trendMinBars, "a five-year line needs a longer anchor than five bars");
  for (const bad of [{ weeklyTrendMinBars: 2, swingBars: 2 }, { weeklyTrendMaxDistanceAtr: 0.1 }, { weeklyTrendMinBars: 1 }] as any[])
    assert.throws(() => parseLevelsSettings(bad), `${JSON.stringify(bad)}`);
  // A line is kept or dropped on the weekly allowance: widening it brings back a line the tighter default refuses.
  const far = levels(bars, parseLevelsSettings({ timeframes: ["5y"], weeklyTrendMaxDistanceAtr: 50 }));
  const near = levels(bars, parseLevelsSettings({ timeframes: ["5y"], weeklyTrendMaxDistanceAtr: 0.5 }));
  const line = (l: typeof far) => l.frames[0]!.trend?.support ?? l.frames[0]!.trend?.resistance;
  assert.ok(!line(near) || Math.abs(line(near)!.toValue - near.price) <= 0.5 * far.frames[0]!.atr! + 1e-9,
    "a tight allowance keeps only a line beside the price");
  assert.ok(line(far), "a wide one admits a distant line");
  // The daily frames must be untouched by any of this.
  const daily = levels(bars, parseLevelsSettings({ timeframes: ["2y"], weeklyTrendMaxDistanceAtr: 0.5, weeklyTrendMinBars: 99 }));
  assert.deepEqual(daily.frames[0]!.trend, levels(bars, parseLevelsSettings({ timeframes: ["2y"] })).frames[0]!.trend);
});
test("moving averages come back as series for drawing, matching the values the answer reports", () => {
  const series = movingAverageSeries(bars, [10, 200]);
  assert.deepEqual(series.map(s => s.period), [10, 200]);
  const ten = series.find(s => s.period === 10)!;
  assert.equal(ten.points.length, bars.time.length - 9, "a point once there are enough bars behind it");
  assert.equal(ten.points[0]!.time, bars.time[9]);
  const byHand = bars.close.slice(0, 10).reduce((a, b) => a + b, 0) / 10;
  assert.ok(Math.abs(ten.points[0]!.value - byHand) < 1e-9);
  // The series must end where the reported average is, or a chart would draw a line the text disagrees with.
  const reported = levels(bars, parseLevelsSettings()).averages.find(a => a.period === 10)!.value!;
  assert.ok(Math.abs(ten.points.at(-1)!.value - reported) < 1e-9, "the line ends at the number in the answer");
  assert.deepEqual(movingAverageSeries({ time: [], open: [], high: [], low: [], close: [] }, [10])[0]!.points, []);
});
