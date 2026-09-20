import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeWindow, levels, parseLevelsSettings, windowStart, type Analysis, type DailyBars, type Frame, type TrendLine } from "../src/levels.ts";
import { syntheticBars, syntheticDowntrendBars } from "./levels-fixture.ts";

const bars = syntheticBars();
const settings = parseLevelsSettings();
const result = levels(bars, settings);
// Both directions: the rising series has the gaps and an up-trend line, the falling one a down-trend line and a base.
const series: Record<string, DailyBars> = { uptrend: bars, downtrend: syntheticDowntrendBars() };
const frame = (timeframe: string): Frame => result.frames.find(f => f.timeframe === timeframe)!;
const close = (actual: number | undefined, expected: number, tolerance = 0.005, what = "") =>
  assert.ok(actual !== undefined && Math.abs(actual - expected) <= tolerance, `${what}: ${actual} vs ${expected}`);

test("the port matches the Python prototype on the same bars, rising and falling (golden parity, unrounded within a cent)", () => {
  const golden = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/levels-golden.json"), "utf8"));
  for (const [name, want0] of Object.entries<any>(golden.series)) parityOf(name, want0);
  function parityOf(name: string, wanted: any) {
  const computed = levels(series[name]!, settings);
  assert.equal(computed.asOf, wanted.lastDate); close(computed.price, wanted.close, 0.005, `${name} close`);
  for (const [timeframe, want] of Object.entries<any>(wanted.timeframes)) {
    const got = computed.frames.find(f => f.timeframe === timeframe)!, where = `${name} ${timeframe}`;
    assert.equal(got.sessions, want.sessions, `${where} sessions`);
    assert.equal(got.sinceListing, want.sinceListing, `${where} sinceListing`);
    assert.equal(got.start, want.start, `${where} start`);
    const price = computed.price;
    if (want.skipped) { assert.ok(got.unavailable, `${where} should be unavailable`); continue; }
    close(got.atr, want.atr, 0.005, `${where} atr`);
    for (const side of ["resistance", "support"] as const) {
      const zones = got[side]!, expected = want[side];
      assert.equal(zones.length, expected.length, `${where} ${side} zone count`);
      zones.forEach((z, i) => {
        const e = expected[i];
        assert.equal(z.id, e.id, `${where} ${side} id`); assert.equal(z.tests, e.tests, `${where} ${z.id} tests`);
        assert.equal(z.last, e.last, `${where} ${z.id} last`);
        close(z.lo, e.lo, 0.005, `${where} ${z.id} lo`); close(z.hi, e.hi, 0.005, `${where} ${z.id} hi`);
        assert.deepEqual(z.members.map(m => [m.date, m.kind]), e.members.map((m: any) => [m.date, m.kind]), `${where} ${z.id} members`);
      });
    }
    assert.deepEqual(got.gaps!.map(g => [g.side, g.from]), want.gaps.map((g: any) => [g.side, g.from]), `${where} gaps`);
    got.gaps!.forEach((g, i) => { close(g.lo, want.gaps[i].lo, 0.005, `${where} gap lo`); close(g.hi, want.gaps[i].hi, 0.005, `${where} gap hi`); });
    for (const key of ["resistance", "support", "resistanceNear", "supportNear"] as const) {
      const line = got.trend![key] as TrendLine | null, e = want.trend[key];
      if (!e) { assert.equal(line, null, `${where} ${key} should be absent`); continue; }
      assert.ok(line, `${where} ${key} missing`);
      assert.equal(line!.from, e.from, `${where} ${key} anchor`); assert.equal(line!.confirmed, e.confirmed, `${where} ${key} confirmed`);
      close(line!.toValue, e.toValue, 0.005, `${where} ${key} value today`);
      close(line!.nextValue, e.nextValue, 0.005, `${where} ${key} value tomorrow`);
      close(line!.slopePerBar, e.slopePerBar, 0.0005, `${where} ${key} slope`);
      assert.deepEqual(line!.touches.map(t => t.time), e.touches.map((t: any) => t.time), `${where} ${key} touches`);
      assert.ok(price > 0);
    }
  }
  }
  const falling = levels(series.downtrend!, settings).frames.find(f => f.timeframe === "2y")!;
  assert.ok(falling.trend!.resistance!.confirmed && falling.trend!.resistance!.slopePerBar < 0, "the falling series has a confirmed down-trend line");
});
test("what the engine says holds together: zones straddle the price, tests are real, gaps are open, lines hold on closes", () => {
  for (const got of result.frames) {
    if (got.unavailable) continue;
    const { atr, width, resistance, support, gaps, trend } = got as Required<Frame>;
    assert.ok(atr > 0 && width > 0);
    for (const z of resistance) assert.ok(z.lo > result.price, `${z.id} above the price`);
    for (const z of support) assert.ok(z.hi < result.price, `${z.id} below the price`);
    for (const z of [...resistance, ...support]) {
      assert.ok(z.hi - z.lo <= width + 1e-9, `${z.id} no wider than the setting`);
      // A zone always comes from a level price traded at; a test is a later visit, which a gapped-past level may lack.
      assert.ok(z.members.length >= 1 && Number.isInteger(z.tests) && z.tests >= 0, `${z.id} comes from a real level`);
      assert.ok(z.members.every(m => m.price >= z.lo - 1e-9 && m.price <= z.hi + 1e-9), `${z.id} members inside it`);
    }
    assert.deepEqual(resistance.map(z => z.id), resistance.map((_, i) => `R${i + 1}`), "ids run nearest first");
    assert.ok(resistance.every((z, i) => i === 0 || z.lo >= resistance[i - 1]!.lo), "resistance zones run upward");
    assert.ok(support.every((z, i) => i === 0 || z.hi <= support[i - 1]!.hi), "support zones run downward");
    for (const g of gaps) {
      assert.ok(g.hi > g.lo, "a gap has a range");
      const after = bars.time.findIndex(x => x === g.from);
      if (g.side === "resistance") assert.ok(bars.high.slice(after + 1).every(h => h < g.hi), "an open gap above was never traded back through");
      else assert.ok(bars.low.slice(after + 1).every(l => l > g.lo), "an open gap below was never traded back through");
    }
    for (const key of ["resistance", "support"] as const) {
      const line = trend[key];
      if (!line) continue;
      assert.equal(line.confirmed, line.touches.length >= settings.trendConfirmTouches, "confirmed means enough touches");
      assert.ok(line.touches.length >= 2, "a line needs its anchors");
      const first = bars.time.indexOf(line.from), last = bars.time.length - 1;
      const perBar = (line.toValue - line.fromValue) / (last - first);
      close(perBar, line.slopePerBar, 1e-6, "the line's slope is its own geometry");
      assert.ok(key === "resistance" ? line.slopePerBar < 0 : line.slopePerBar > 0, "a resistance line falls, a support line rises");
    }
  }
});
test("settings are validated, and changing one changes the answer in the direction it should", () => {
  assert.equal(parseLevelsSettings().swingBars, 2);
  assert.deepEqual(parseLevelsSettings().movingAverages, [10, 21, 50, 200]);
  for (const bad of [{ swingBars: 0 }, { swingBars: 2.5 }, { atrBars: 1 }, { zoneWidthAtr: 0 }, { trendConfirmTouches: 1 },
    { minSessions: 4 }, { movingAverages: [10, 10] }, { movingAverages: [1] }, { timeframes: [] }, { timeframes: ["decade"] },
    { trendMinBars: 2, swingBars: 2 }, { atrBars: 50, minSessions: 20 }, { nonsense: 1 }] as any[]) assert.throws(() => parseLevelsSettings(bad), `${JSON.stringify(bad)}`);
  const strict = levels(bars, parseLevelsSettings({ trendConfirmTouches: 6 }));
  assert.equal(strict.frames.find(f => f.timeframe === "2y")!.trend!.support!.confirmed, false, "a higher bar leaves the same line unconfirmed");
  const wide = levels(bars, parseLevelsSettings({ zoneWidthAtr: 2 })), narrow = levels(bars, parseLevelsSettings({ zoneWidthAtr: 0.1 }));
  assert.ok(narrow.frames.find(f => f.timeframe === "2y")!.support!.length >= wide.frames.find(f => f.timeframe === "2y")!.support!.length,
    "narrower zones split what wider ones merge");
  assert.ok(levels(bars, parseLevelsSettings({ trendMaxDistanceAtr: 1 })).frames.every(f => !f.trend?.support), "a line far from the price is no longer a level");
});
test("thin, broken or stale history is named, never computed through", () => {
  const short: DailyBars = { time: bars.time.slice(-10), open: bars.open.slice(-10), high: bars.high.slice(-10), low: bars.low.slice(-10), close: bars.close.slice(-10) };
  const thin = levels(short, settings);
  assert.match(thin.warnings[0]!, /only 10 sessions/); assert.ok(thin.frames.every(f => f.unavailable), "no frame invents levels");
  assert.equal(levels({ time: [], open: [], high: [], low: [], close: [] }, settings).warnings[0], "no price history");
  const broken = { ...bars, high: bars.high.slice(0, -1) };
  assert.equal(levels(broken, settings).warnings[0], "price history is incomplete");
  const negative = { ...bars, close: bars.close.map((c, i) => i === 5 ? 0 : c) };
  assert.equal(levels(negative, settings).warnings[0], "price history has invalid prices");
  const shuffled = { ...bars, time: [...bars.time.slice(1), bars.time[0]!] };
  assert.equal(levels(shuffled, settings).warnings[0], "price history is out of order");
  const flat: DailyBars = { time: bars.time.slice(-30), open: Array(30).fill(50), high: Array(30).fill(50), low: Array(30).fill(50), close: Array(30).fill(50) };
  assert.equal((analyzeWindow(flat, settings) as { unavailable: string }).unavailable, "no price movement in this window");
});
test("a split the feed did not adjust is called out, not silently turned into levels", () => {
  const halved = { ...bars, open: [...bars.open], high: [...bars.high], low: [...bars.low], close: [...bars.close] };
  for (let i = 200; i < halved.time.length; i++) for (const key of ["open", "high", "low", "close"] as const) halved[key][i] = halved[key][i]! / 2;
  assert.match(levels(halved, settings).warnings[0]!, /a split may not be adjusted/);
  assert.deepEqual(result.warnings, [], "the clean fixture warns about nothing");
});
test("the default timeframe is the longest one with levels, and a live quote replaces the last close", () => {
  assert.equal(result.defaultTimeframe, "2y");
  const january = { ...bars, time: bars.time.map((_, i) => new Date(Date.parse("2026-01-02T00:00:00Z") + i * 86400000).toISOString().slice(0, 10)) };
  const earlyYear = levels(january, settings);
  assert.equal(earlyYear.defaultTimeframe, "2y", "early in January the 2-year window still answers");
  assert.equal(result.priceSource, "close");
  const withQuote = levels(bars, settings, result.price + 6);
  assert.equal(withQuote.priceSource, "quote"); close(withQuote.price, result.price + 6, 1e-9, "quote price");
  const moved = withQuote.frames.find(f => f.timeframe === "2y")!;
  assert.ok(moved.support!.length > frame("2y").support!.length, "a higher quote turns old resistance into support");
});
test("the zone boundary is exact: levels a zone width apart share a zone, a cent further start a new one", () => {
  // Bars whose true range is always 2.00, so ATR is 2.00 and a zone is 1.00 wide, and two highs sit exactly that far apart.
  const build = (secondHigh: number): DailyBars => {
    const time: string[] = [], open: number[] = [], high: number[] = [], low: number[] = [], close: number[] = [];
    for (let i = 0; i < 40; i++) {
      const day = new Date(Date.parse("2026-01-05T00:00:00Z") + i * 86400000 * 1.4).toISOString().slice(0, 10);
      time.push(day); open.push(100); close.push(100); high.push(101); low.push(99);
    }
    high[10] = 110; low[10] = 108; open[10] = 109; close[10] = 109;            // a swing high at 110
    high[20] = secondHigh; low[20] = secondHigh - 2; open[20] = secondHigh - 1; close[20] = secondHigh - 1;
    return { time, open, high, low, close };
  };
  const zonesFor = (secondHigh: number) => {
    const out = analyzeWindow(build(secondHigh), parseLevelsSettings({ minSessions: 20 }), 0);
    assert.ok(!("unavailable" in out));
    const zones = (out as { resistance: { lo: number; hi: number }[] }).resistance;
    assert.equal((out as { width: number }).width, 1, "a 2.00 range every day makes a 1.00 zone width");
    return zones.filter(z => z.lo > 105);   // the zones around the two swing highs, not the recent bars' own zone
  };
  assert.equal(zonesFor(111).length, 1, "exactly one width apart: one zone");
  assert.equal(zonesFor(111.01).length, 2, "a cent wider apart: two zones");
});
test("prices that are not round numbers group the same way, and the ATR is averaged over the bars there are", () => {
  // Real quotes carry cents tails; a fixture of clean two-decimal prices would never exercise the comparison's edge.
  const odd = (i: number) => Math.round((100 + Math.sin(i * 1.7) * 3 + i * 0.0137) * 10000) / 10000;
  const time: string[] = [], open: number[] = [], high: number[] = [], low: number[] = [], closes: number[] = [];
  for (let i = 0; i < 60; i++) {
    time.push(new Date(Date.parse("2026-01-05T00:00:00Z") + i * 86400000 * 1.4).toISOString().slice(0, 10));
    const c = odd(i); open.push(c); closes.push(c); high.push(Math.round((c + 1.0033) * 10000) / 10000); low.push(Math.round((c - 0.9967) * 10000) / 10000);
  }
  const uneven: DailyBars = { time, open, high, low, close: closes };
  const got = analyzeWindow(uneven, settings, 0);
  assert.ok(!("unavailable" in got), "irregular prices still compute");
  const { atr, width, resistance, support } = got as Required<Analysis>;
  assert.ok(atr > 0 && Number.isFinite(atr));
  for (const z of [...resistance, ...support]) assert.ok(z.hi - z.lo <= width + 1e-9, `${z.id} respects the width on uneven prices`);
  // Fewer bars than atrBars: the average is over the ranges that exist, not deflated by dividing by the setting.
  const eight: DailyBars = { time: time.slice(0, 8), open: open.slice(0, 8), high: high.slice(0, 8), low: low.slice(0, 8), close: closes.slice(0, 8) };
  const short = analyzeWindow(eight, parseLevelsSettings({ atrBars: 14, minSessions: 14 }), 0) as Required<Analysis>;
  const ranges = [high[0]! - low[0]!, ...Array.from({ length: 7 }, (_, x) => Math.max(high[x + 1]! - low[x + 1]!, Math.abs(high[x + 1]! - closes[x]!), Math.abs(low[x + 1]! - closes[x]!)))];
  close(short.atr, ranges.reduce((a, b) => a + b, 0) / ranges.length, 1e-9, "ATR over 8 bars, not 14");
});
test("windows start where the calendar says", () => {
  assert.equal(windowStart("2026-09-09", "qtd"), "2026-07-01");
  assert.equal(windowStart("2026-01-05", "qtd"), "2026-01-01");
  assert.equal(windowStart("2026-09-09", "ytd"), "2026-01-01");
  assert.equal(windowStart("2026-09-09", "2y"), "2024-09-09");
});

// ── Breakouts (B1): the engine names what it already knew ─────────────────────────────────────────────────────
//
// The founder, reading his own charts: "RBRK and INTC have both broken out - in different ways... you are right to
// say they are just above support, but they have also broken out, which is a better/bigger signal." The engine
// already computed the flip — ZoneMember.kind carries "broken resistance" — and nothing outside this module read
// it, so a zone that was a ceiling until three weeks ago and one that has been a floor for two years printed the
// same string.

/** Bars built to order. Every test here needs a specific shape, and a shared fixture would hide which bar matters. */
function barsOf(rows: [high: number, low: number, close: number][]): DailyBars {
  const time = rows.map((_, i) => {
    const day = new Date(Date.UTC(2026, 0, 5) + i * 86_400_000);   // a Monday; weekends are irrelevant to the engine
    return day.toISOString().slice(0, 10);
  });
  return { time, open: rows.map(r => r[2]), high: rows.map(r => r[0]), low: rows.map(r => r[1]), close: rows.map(r => r[2]) };
}
/** N bars oscillating into a ceiling at `hi` without closing through it. */
const under = (n: number, hi: number): [number, number, number][] =>
  Array.from({ length: n }, (_, i) => i % 2 === 0 ? [hi - 0.1, hi - 4, hi - 1] : [hi - 3, hi - 6, hi - 5]);
/** N bars clear above `hi`. */
const above = (n: number, hi: number): [number, number, number][] =>
  Array.from({ length: n }, () => [hi + 6, hi + 3, hi + 5]);

const analyzed = (rows: [number, number, number][], over: Record<string, unknown> = {}) => {
  const out = analyzeWindow(barsOf(rows), parseLevelsSettings(over));
  assert.ok(!("unavailable" in out), `analyzable: ${"unavailable" in out ? out.unavailable : ""}`);
  return out as Exclude<typeof out, { unavailable: string }>;
};
/** The broken zone a reader means: the one that actually held the price back, not an incidental level it crossed.
 *  Ranked by testsBefore, because that is the measure that separates a range from a bar the price passed. */
const brokenZone = (a: ReturnType<typeof analyzed>) =>
  a.support.filter(z => z.broke).sort((x, y) => y.broke!.testsBefore - x.broke!.testsBefore)[0];
/** The break of the zone straddling one price, on either side. Asking about a level rather than about the window,
 *  because these fixtures oscillate and so carry a lower level the price genuinely does break. */
const breakAt = (a: ReturnType<typeof analyzed>, level: number) =>
  [...a.support, ...a.resistance].find(z => z.lo <= level + 0.5 && z.hi >= level - 0.5)?.broke;

test("a zone the price closed up through is named, with the session it went on", () => {
  const a = analyzed([...under(40, 107), ...above(8, 107)]);
  const zone = brokenZone(a);
  assert.ok(zone, "the ceiling it broke is now a support zone carrying a break");
  assert.equal(zone!.broke!.direction, "above");
  assert.equal(zone!.broke!.on, a.support[0] && barsOf([...under(40, 107), ...above(8, 107)]).time[40],
    "the date is the FIRST close through, not the latest");
  assert.equal(zone!.broke!.closes, 8, "and it counts the closes since");
  assert.equal(zone!.broke!.barsSince, 7);
  assert.ok(zone!.broke!.recent);

  // The member kind was already there and said less: it means only "a former swing high now below the price",
  // which is true of a high the stock drifted past years ago and carries no claim that anything broke.
  assert.ok(zone!.members.some(m => m.kind === "broken resistance"), "the flip is visible in the members too");
});

test("a break's date does not move when nothing happens", () => {
  // The margin is sized from a WINDOW-mean ATR, not the trailing one the zone widths use. With the trailing ATR a
  // claim about a February session would be re-adjudicated by this week's volatility: after a breakout the range
  // expands, the margin widens, the walk-back terminates later, and the page prints a LATER break date with no new
  // price action behind it. A date that moves on its own is the plainest way to state a number you cannot stand
  // behind.
  const rows: [number, number, number][] = [...under(40, 107), ...above(8, 107)];
  const before = brokenZone(analyzed(rows))!.broke!;
  // One flat session: no range, no news.
  const after = brokenZone(analyzed([...rows, [112, 112, 112]]))!.broke!;
  assert.equal(after.on, before.on, "the session it broke on is a fact about February, not about today");
  assert.equal(after.testsBefore, before.testsBefore);
  assert.equal(after.closes, before.closes + 1, "only the count of closes since moves, because one was added");
});

test("what counts as through it: a margin, a close, and more than one of them", () => {
  const ceiling = 107;
  // Barely over the edge is not a break of anything.
  const grazed: [number, number, number][] = [...under(40, ceiling), ...Array.from({ length: 6 },
    () => [ceiling + 0.2, ceiling - 0.5, ceiling + 0.05] as [number, number, number])];
  assert.equal(breakAt(analyzed(grazed), ceiling), undefined, "a close a few cents past the edge clears no margin");

  // Trading through without closing through is a wick, and the rest of this engine lives by closes.
  const wicked: [number, number, number][] = [...under(40, ceiling), ...Array.from({ length: 6 },
    () => [ceiling + 9, ceiling - 4, ceiling - 2] as [number, number, number])];
  assert.equal(breakAt(analyzed(wicked), ceiling), undefined, "a high above the zone that closed back inside is not a break");

  // One close through is the more intuitive reading and is available as a setting; two is the default, because the
  // page makes a claim in words and a one-day print that reverses turns it into a retraction on the next run.
  const once: [number, number, number][] = [...under(40, ceiling), ...above(1, ceiling)];
  assert.equal(breakAt(analyzed(once), ceiling), undefined, "one close is not enough by default");
  assert.ok(breakAt(analyzed(once, { breakConfirmBars: 1 }), ceiling), "and is enough when asked for");
});

test("a price that was never below a zone did not break it", () => {
  // Every old low in a long uptrend sits below the price. Without this rule each one becomes a fresh breakout, and
  // the page fills with breaks that nobody watched happen.
  const a = analyzed(Array.from({ length: 50 }, (_, i) => [100 + i, 99 + i, 99.8 + i] as [number, number, number]));
  assert.ok(a.support.length > 0, "there are support zones beneath a climbing price");
  assert.equal(a.support.filter(z => z.broke).length, 0, "and none of them is a break");
});

test("testsBefore counts the side the zone was, not the side it is", () => {
  const a = analyzed([...under(40, 107), ...above(8, 107)]);
  const zone = a.support.find(z => z.broke && z.hi > 106 && z.lo < 108);
  assert.ok(zone, "the former ceiling");
  // Twenty of the forty bars reached the ceiling and closed back below it. That is what "the range it was stuck
  // in" means, and it is the number a reader would assume "held N" was telling them.
  assert.ok(zone!.broke!.testsBefore >= 15, `it turned the price back ${zone!.broke!.testsBefore} times before`);
  // Zone.tests is the OTHER rule applied across the break: it asks whether bars closed ABOVE this zone, which the
  // forty bars under the ceiling did not. The two numbers must not be conflated, and this is why.
  assert.notEqual(zone!.tests, zone!.broke!.testsBefore,
    "tests and testsBefore answer different questions about the same zone");
});

test("a break given back says so, and an unconfirmed one never happened", () => {
  const ceiling = 107;
  // Above for six sessions, then back inside.
  const given: [number, number, number][] = [...under(30, ceiling), ...above(6, ceiling),
    ...Array.from({ length: 3 }, () => [ceiling - 1, ceiling - 5, ceiling - 3] as [number, number, number])];
  const back = analyzed(given).resistance.find(z => z.broke);
  assert.ok(back, "the zone is a ceiling again, and remembers");
  assert.ok(back!.broke!.backInsideOn, "the session it closed back inside is named");
  assert.equal(back!.broke!.closes, 6, "and the run above it is still counted");

  // One close above, then back: never confirmed, so there is nothing to give back.
  const flickered: [number, number, number][] = [...under(30, ceiling), ...above(1, ceiling),
    ...Array.from({ length: 4 }, () => [ceiling - 1, ceiling - 5, ceiling - 3] as [number, number, number])];
  assert.equal(analyzed(flickered).resistance.find(z => z.broke), undefined,
    "a single close that reversed is not a break that was given back — it is not a break");
});

test("a stock above every high in its window has nothing overhead, and says so", () => {
  // The RBRK shape: each bar makes the high, so nothing has ever traded above the price.
  const climbing = Array.from({ length: 50 }, (_, i) =>
    [100 + i * 0.8 + 0.5, 100 + i * 0.8 - 0.5, 100 + i * 0.8 + 0.3] as [number, number, number]);
  const a = analyzed(climbing);

  // The trap this exists for: `recentBars` injects the last few bars' highs as resistance candidates, so on the day
  // a stock prints a new high its OWN session high becomes a zone a few cents overhead. A naive check on
  // `resistance.length` never fires for precisely the stock that just made a new high.
  assert.ok(a.resistance.length > 0, "there is a raw zone — the price's own last bars");
  assert.equal(a.overhead.zones, 0, "but nothing that is prior structure");
  assert.ok(a.resistance.every(z => z.members.every(m => m.fromRecentBar)),
    "because every member of it is the price's own recent footprint");
  assert.equal(a.overhead.gaps, 0);
  assert.equal(a.overhead.line, false);

  // And a stock with a real high above it is not clear air.
  const capped = analyzed([...above(6, 120), ...under(40, 107)]);
  assert.ok(capped.overhead.zones > 0, "a prior high overhead is counted");
});

test("a stock can have broken out and have nothing above it, without the two facts interfering", () => {
  // Both at once is the RBRK case as the founder described it, and the page has to be able to say both.
  const rows: [number, number, number][] = [...under(30, 107), ...Array.from({ length: 10 },
    (_, i) => [108 + i, 107.2 + i, 107.8 + i] as [number, number, number])];
  const a = analyzed(rows);
  assert.ok(a.support.some(z => z.broke?.direction === "above"), "it broke a ceiling");
  assert.equal(a.overhead.zones, 0, "and there is nothing above it now");
});

test("a live quote moves the zones but never creates a break", () => {
  // A break is a claim about a settled session. An after-hours print that reverses by the open would make the page
  // assert something that never settled, and a badge appearing at 10:04 and gone by 15:30 is a scanner.
  const rows: [number, number, number][] = [...under(40, 107), ...Array.from({ length: 4 },
    () => [106.9, 103, 106] as [number, number, number])];
  const settled = analyzed(rows);
  assert.equal(breakAt(settled, 107), undefined, "no settled close went through the ceiling");

  const quoted = analyzeWindow(barsOf(rows), parseLevelsSettings(), 0, 118) as Exclude<
    ReturnType<typeof analyzeWindow>, { unavailable: string }>;
  // The quote re-files the ceiling as support, exactly as it does today — that behaviour is unchanged and expected.
  assert.ok(quoted.support.length > settled.support.length, "the quote moves zones between sides, as it always has");
  assert.equal(breakAt(quoted, 107), undefined,
    "but a zone on the support side with no break is the correct intraday state, not a bug to fix");
});

test("the break settings are validated like every other number in this engine", () => {
  // A strategy constant is a user setting with a default, never a literal buried in a branch.
  const s = parseLevelsSettings();
  assert.equal(s.breakCloseAtr, 0.25); assert.equal(s.breakConfirmBars, 2); assert.equal(s.breakRecentBars, 30);
  assert.equal(s.breakMinTests, 2);
  assert.throws(() => parseLevelsSettings({ breakMinTests: -1 }), /breakMinTests/);
  assert.throws(() => parseLevelsSettings({ breakConfirmBars: 0 }), /breakConfirmBars/);
  assert.throws(() => parseLevelsSettings({ breakConfirmBars: 2.5 }), /breakConfirmBars/, "an integer setting");
  assert.throws(() => parseLevelsSettings({ breakCloseAtr: -1 }), /breakCloseAtr/);
  assert.throws(() => parseLevelsSettings({ breakRecentBars: 0 }), /breakRecentBars/);
  assert.throws(() => parseLevelsSettings({ breakRecentBars: 501 }), /breakRecentBars/);

  // Recency is a threshold, not a filter baked into the data: an older break keeps its date and is simply not
  // recent, so get_levels stays complete and the threshold stays adjustable.
  const rows: [number, number, number][] = [...under(30, 107), ...above(12, 107)];
  const recent = brokenZone(analyzed(rows))!.broke!;
  const stale = brokenZone(analyzed(rows, { breakRecentBars: 3 }))!.broke!;
  assert.equal(stale.on, recent.on, "the date is unchanged");
  assert.equal(recent.recent, true);
  assert.equal(stale.recent, false, "only whether it is still worth saying changes");
});

test("nothing the engine now names reads as a recommendation", () => {
  // A field name is an instruction to whatever model reads get_levels. `broke`, `recent`, `overhead` and
  // `testsBefore` are nouns for events and counts; anything comparative would be the product adopting the
  // founder's own read ("a better/bigger signal") as its voice.
  const a = analyzed([...under(40, 107), ...above(8, 107)]);
  const serialized = JSON.stringify(a);
  for (const banned of ["signal", "strength", "score", "opportunity", "bullish", "bearish", "target", "important",
    "strong", "weak", "buy", "sell"])
    assert.ok(!new RegExp(`"[^"]*${banned}`, "i").test(serialized), `no field named for ${banned}`);
});
