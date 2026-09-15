import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeWindow, levels, parseLevelsSettings, windowStart, type DailyBars, type Frame, type TrendLine } from "../src/levels.ts";
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
    { trendMinBars: 2, swingBars: 2 }, { nonsense: 1 }] as any[]) assert.throws(() => parseLevelsSettings(bad), `${JSON.stringify(bad)}`);
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
test("windows start where the calendar says", () => {
  assert.equal(windowStart("2026-09-09", "qtd"), "2026-07-01");
  assert.equal(windowStart("2026-01-05", "qtd"), "2026-01-01");
  assert.equal(windowStart("2026-09-09", "ytd"), "2026-01-01");
  assert.equal(windowStart("2026-09-09", "2y"), "2024-09-09");
});
