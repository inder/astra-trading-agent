import { test } from "node:test";
import assert from "node:assert/strict";
import { BOX_SETTINGS, BOX_SETTING_KEYS, boxConfig, parseBoxConfig } from "../src/box-settings.ts";
import { anchoredVwaps, barCandles, contraction, runawayGate, scanDay, sizedEntry, staticSupports, supportUnderBox, vwapBars, type Candle } from "../src/box-rules.ts";
import { barCandleCloses } from "../src/orb-rules.ts";
import { sessionTimes } from "../src/daily-history.ts";
import { BOX_FIRST_HALF, BOX_SECOND_HALF, BREAKOUT, DAY, INSIDE_AFTER, PRE_BOX, laggardDailies, referenceBars, runawayDailies } from "./box-fixture.ts";

// Every price here is invented, shaped like SOXL, RKT and IBM on 2026-10-05. Times are New York wall clock (the box
// 9:46..10:12, the first close above it ending 10:14); a candle is named by its start.
const config = boxConfig(DAY, ["SOXL"]);
const et = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit" });
const scan = (o = {}, c = config, daily = runawayDailies()) => scanDay(referenceBars(o), daily, c);

test("settings: every number is a row with the founder's placeholder default, and out-of-range or unknown values are refused", () => {
  const d = Object.fromEntries(BOX_SETTING_KEYS.map(k => [k, BOX_SETTINGS[k].default]));
  assert.equal(d.maxBoxHeightAtr, 0.25); assert.equal(d.minBoxMinutes, 10); assert.equal(d.supportReachAtr, 0.5); assert.equal(d.contractionMaxRatio, 0.7);
  assert.equal(d.contractionLookbackCandles, 5); assert.equal(d.riskCents, 50_000); assert.equal(d.breakoutLookbackSessions, 10); assert.equal(d.maxBelowHighFraction, 0.1);
  assert.equal(parseBoxConfig(config).symbols[0], "SOXL");
  assert.throws(() => boxConfig(DAY, ["SOXL"], { maxBoxHeightAtr: 5 }), /Invalid/);
  assert.throws(() => boxConfig(DAY, ["SOXL"], { minBoxMinutes: 3 }), /Invalid/, "a box shorter than two candles has no second half");
  assert.throws(() => boxConfig(DAY, ["SOXL"], { shortAveragePeriod: 30 }), /Invalid/, "the short average must be shorter than the long one");
  assert.throws(() => parseBoxConfig({ ...config, surprise: 1 }), /Invalid/);
});

test("a runaway stock passes the gate, and the journal shows every check with its numbers", () => {
  const g = runawayGate(runawayDailies(), config);
  assert.ok(g.fired);
  assert.deepEqual((g.evidence.checks as any[]).map(c => [c.name, c.pass]), [["shortAverage", true], ["longAverage", true], ["nearHigh", true], ["brokeResistance", true]]);
});
test("a stock below its averages, far under its high, with nothing broken (RKT, IBM shaped) fails every check", () => {
  const g = runawayGate(laggardDailies(), config);
  assert.ok(!g.fired); assert.ok((g.evidence.checks as any[]).every(c => !c.pass));
  const s = scanDay(referenceBars(), laggardDailies(), config);
  assert.equal(s.status, "not_runaway"); assert.deepEqual(s.boxes, []);
});
test("near misses: a close more than the allowed distance under the high fails; a break older than the lookback fails", () => {
  const d = runawayDailies(), n = d.close.length;
  const far = { ...d, close: [...d.close.slice(0, n - 1), 140] };
  assert.ok(!(runawayGate(far, config).evidence.checks as any[]).find(c => c.name === "nearHigh").pass);
  const old = runawayGate(d, boxConfig(DAY, ["SOXL"], { breakoutLookbackSessions: 1 }));
  assert.ok(!old.fired); assert.ok(!(old.evidence.checks as any[]).find(c => c.name === "brokeResistance").pass);
  const last = (k: number) => ({ time: d.time.slice(-k), open: d.open.slice(-k), high: d.high.slice(-k), low: d.low.slice(-k), close: d.close.slice(-k) });
  const short = runawayGate(last(40), config);   // a stock with 40 sessions has not shown a three-month high
  assert.ok(!short.fired); assert.equal(short.evidence.unavailable, "not enough daily history");
  const stale = runawayGate({ ...d, time: d.time.map((t, i) => i === n - 1 ? "2026-10-01" : t) }, config);   // the feed lags a session
  assert.ok(!stale.fired); assert.match(String(stale.evidence.unavailable), /previous session/);
});

test("supports: the broken zone and its breakout-session high, and the averages; each type can be switched off", () => {
  const kinds = (c = config) => new Set(staticSupports(runawayDailies(), c).map(s => s.kind));
  assert.deepEqual([...kinds()].sort(), ["average", "breakout_high", "broken_resistance"]);
  assert.deepEqual([...kinds(boxConfig(DAY, ["X"], { useAverages: 0, useBrokenResistance: 0 }))], []);
});
test("an anchored VWAP is the volume-weighted typical price from that session's open, and never reads a minute that had not finished", () => {
  const daily = runawayDailies(), bars = vwapBars(referenceBars()), { open } = sessionTimes(DAY);
  const at = (asOf: number, c = config) => anchoredVwaps(bars, daily, c, asOf);
  // Through the prior close only: Oct 1 (typical 154) and Oct 2 (typical 162), equal volume, so 158.
  const prior = at(open, boxConfig(DAY, ["X"], { vwapIncludesToday: 0 })).find(s => s.label.includes("10-01"))!;
  assert.ok(Math.abs(prior.lo - 158) < 0.001, `${prior.lo}`);
  // As of 10:00 it counts today's finished minutes; changing a later bar changes nothing.
  const asOf = open + 30 * 60000, before = at(asOf).find(s => s.label.includes("10-01"))!.lo;
  const edited = referenceBars().map(b => Date.parse(b.begins_at) >= asOf ? { ...b, close_price: "999", high_price: "999", low_price: "999" } : b);
  assert.equal(anchoredVwaps(vwapBars(edited), daily, config, asOf).find(s => s.label.includes("10-01"))!.lo, before);
  assert.deepEqual(at(open, boxConfig(DAY, ["X"], { useAnchoredVwaps: 0 })), []);
  assert.equal(at(open, boxConfig(DAY, ["X"], { vwapMaxSessionsBack: 2 })).length, 2);
});
test("a padded (interpolated) or zero-volume minute is not a trade and does not enter a VWAP", () => {
  const good = referenceBars(), padded = good.map((b, i) => i === 5 ? { ...b, interpolated: true } : i === 6 ? { ...b, volume: "0" } : b);
  assert.equal(vwapBars(padded).length, vwapBars(good).length - 2);
});

test("candles sit on the 2-minute grid from 9:32, are named by their start, and agree with the minute-bar reference closes", () => {
  const bars = referenceBars(), candles = barCandles(bars, DAY, 2), { open } = sessionTimes(DAY);
  assert.equal(candles[0]!.start, open + 2 * 60000); assert.equal(candles[0]!.end - candles[0]!.start, 120000);
  const reference = barCandleCloses(bars.filter(b => Date.parse(b.begins_at) >= open + 120000).map(b => ({ at: Date.parse(b.begins_at), close: +b.close_price })), open + 120000, 2);
  assert.deepEqual(candles.map(c => [c.end, c.close]), reference.map(c => [c.end, c.close]));
});
test("a candle missing one of its minutes, or padded, has no known close (ADR 0001), and a missing candle is unobserved too", () => {
  const dropped = barCandles(referenceBars({ drop: [3] }), DAY, 2);
  assert.equal(dropped[3]!.close, null); assert.notEqual(dropped[2]!.close, null);
  const padded = referenceBars().map(b => b.begins_at === new Date(sessionTimes(DAY).open + 8 * 60000).toISOString() ? { ...b, interpolated: true } : b);
  assert.equal(barCandles(padded, DAY, 2)[3]!.close, null);
});

test("the reference day: one box, 9:46 to 10:12, floor 158.08, high 160.22, height 0.18 ATR, volatility shrinking, first close above it ends 10:14", () => {
  const s = scan();
  assert.equal(s.status, "scanned"); assert.equal(s.boxes.length, 1);
  const b = s.boxes[0]!;
  assert.equal(b.status, "decided");
  assert.deepEqual([et(b.box.start), et(b.box.end)], ["09:46", "10:12"]);
  assert.equal(b.box.low, 158.08); assert.equal(b.box.high, 160.22); assert.equal(b.box.height, 2.14);
  assert.ok(Math.abs(b.box.heightToAtr - 2.14 / s.atr!) < 0.001 && b.box.heightToAtr < 0.25 && b.box.heightToAtr > 0.17, `${b.box.heightToAtr}`);
  assert.ok((b.contraction as any).ratio <= 0.7 && (b.contraction as any).evaluable);
  assert.deepEqual([b.decision!.direction, et(b.decision!.candleEnd), b.decision!.close], ["up", "10:14", 160.71]);
  assert.equal((b.support as any).kind, "anchored_vwap");
});
test("the breakout candle would still fit under the height limit, yet it is not swallowed into the box", () => {
  const s = scan(), limit = config.maxBoxHeightAtr * s.atr!, b = s.boxes[0]!;
  assert.ok(BREAKOUT[0]![1] - b.box.low < limit, "the breakout candle fits");
  assert.equal(b.box.high, 160.22);
});
test("the journaled entries: A is a quarter of the box above its low, B is the up-decision close, the stop is the box low, shares risk $500", () => {
  const e = scan().boxes[0]!.entries!;
  assert.equal(e.stop, 158.08); assert.equal(e.A.price, 158.615); assert.equal(e.B.price, 160.71);
  assert.equal(e.A.shares, Math.floor(500 / 0.535)); assert.equal(e.B.shares, Math.floor(500 / 2.63));
  assert.ok(e.A.shares * e.A.riskPerShare <= 500 && e.B.shares * e.B.riskPerShare <= 500);
  assert.equal(e.B.notional, Math.round(e.B.shares * 160.71 * 1e4) / 1e4);
});
test("sizing: whole shares rounded down, none when the stop is not below the entry", () => {
  assert.equal(sizedEntry(100, 99, config).shares, 500); assert.equal(sizedEntry(100, 99.7, config).shares, 1666);
  assert.equal(sizedEntry(100.42, 100.32, config).shares, 5000, "10 cents of risk is 10 cents, not 10.000000000000853");
  assert.equal(sizedEntry(100, 100, config).shares, 0); assert.equal(sizedEntry(100, 101, config).shares, 0);
});
test("pre-box candles that happen to fit under the limit are not pulled into the box, and a box cannot start before it has candles to compare with", () => {
  const b = scan().boxes[0]!;
  assert.equal(et(b.box.start), "09:46");   // the 9:44 flush down to 156.9 is outside: with the box it would be 3.3 tall
  const tooEarly = scan({ pre: PRE_BOX.slice(4) }).boxes;   // only three candles before the box
  assert.deepEqual(tooEarly, [], "fewer than five candles before the box means contraction cannot be judged, so no box");
});

test("near miss: a box a hair too tall is rejected, a hair shorter is accepted", () => {
  const s = scan(), ratio = 2.14 / s.atr!;
  const tooTall = scan({}, boxConfig(DAY, ["X"], { maxBoxHeightAtr: Math.round((ratio - 0.003) * 1e3) / 1e3 }));
  // The 2.14-tall box is not accepted. A shorter one may still form, and a later low (the 158.08 double bottom) that would
  // push it over the limit is counted as a wick, never as a bound.
  assert.ok(tooTall.boxes.length >= 1 && tooTall.boxes.every(b => b.box.height < 2.14 && b.box.low > 158.08));
  assert.equal(scan({}, boxConfig(DAY, ["X"], { maxBoxHeightAtr: Math.round((ratio + 0.003) * 1e3) / 1e3 })).boxes.length, 1);
});
test("near miss: no contraction (the second half is as busy as the first) is rejected", () => {
  const busier = BOX_SECOND_HALF.map(([o, h, l, c]) => [o, Math.min(h + 0.15, 160.22), Math.max(l - 0.15, 158.08), c] as const);
  const r = scan({ second: busier.map(x => [...x] as [number, number, number, number]) }, boxConfig(DAY, ["X"], { contractionMaxRatio: 0.55 }));
  assert.equal(r.boxes.length, 0);
  assert.equal(scan({}, boxConfig(DAY, ["X"], { contractionMaxRatio: 0.55 })).boxes.length, 1, "while the real second half passes the same limit");
  const flat = (r: number): Candle[] => Array.from({ length: 4 }, (_, i) => ({ start: i, end: i + 1, high: 10 + r, low: 10, close: 10 }));
  assert.ok(!contraction(flat(1), flat(1).concat(flat(1)), config).fired);
  assert.ok(contraction(flat(0.5), flat(1).concat(flat(1)), config).fired);
});
test("near miss: a box that sits below its support (more than the slack under it, and no support beneath it) is rejected", () => {
  assert.equal(scan({ priorTypical: [175, 175, 175] }, boxConfig(DAY, ["X"], { useAverages: 0, useBrokenResistance: 0 })).boxes.length, 0);
  const at = (low: number, supports = [{ kind: "average" as const, label: "x", lo: 100, hi: 100 }]) => supportUnderBox(low, supports, 10, config).fired;
  assert.ok(at(100) && at(104.9) && at(99.1), "within reach above and within slack below");
  assert.ok(!at(105.1), "too far above"); assert.ok(!at(98.9), "wick-through bigger than the slack");
});
test("near miss: a box too short (under 10 minutes) is not a box", () => {
  assert.equal(scan({}, boxConfig(DAY, ["X"], { minBoxMinutes: 120 })).boxes.filter(b => b.status === "decided").length, 0);
});
test("a candle whose close is unknown voids a live box and is never acted on (ADR 0001)", () => {
  // the breakout candle is the 14th after 9:32: drop one of its minutes
  const n = PRE_BOX.length + BOX_FIRST_HALF.length + BOX_SECOND_HALF.length + INSIDE_AFTER.length;
  const b = scan({ drop: [n] }).boxes[0]!;
  assert.equal(b.status, "voided"); assert.equal(b.voided!.reason, "candle_unobserved"); assert.equal(b.decision, null); assert.equal(b.entries, null);
});
test("a close below the box is a decision for the bears: direction only, no entries", () => {
  const b = scan({ breakout: [[159.6, 159.7, 157.0, 157.5]] }).boxes[0]!;
  assert.deepEqual([b.status, b.decision!.direction, b.entries], ["decided", "down", null]);
});
test("a wick through the height limit that closes inside is counted but never becomes a box bound", () => {
  const second = BOX_SECOND_HALF.map(c => [...c] as [number, number, number, number]); second[2] = [158.7, 159.5, 154.0, 159.3];
  const b = scan({ second }).boxes[0]!;
  assert.equal(b.status, "decided"); assert.equal(b.box.low, 158.08); assert.equal(b.box.wickOutsideCandles, 1);
});
test("a box still open when the bars end is live, with no decision", () => {
  const r = scan({ breakout: [], after: [] }).boxes;
  assert.deepEqual([r.length, r[0]!.status, r[0]!.decision], [1, "live", null]);
});
test("a candle still forming when the bars end is not a candle: a live box stays live instead of being voided", () => {
  const bars = referenceBars({ breakout: [], after: [] }), partial = [...bars, { ...bars.at(-1)!, begins_at: new Date(Date.parse(bars.at(-1)!.begins_at) + 60000).toISOString() }];
  const r = scanDay(partial, runawayDailies(), config).boxes;
  assert.deepEqual([r.length, r[0]!.status], [1, "live"]);
  assert.equal(barCandles(partial, DAY, 2).length, barCandles(bars, DAY, 2).length);
});
test("a candle with an unknown close cannot count as the volatility a box is compared with", () => {
  const known: Candle = { start: 0, end: 1, high: 2, low: 1, close: 1.5 }, partial: Candle = { ...known, close: null };
  const before = Array.from({ length: 5 }, () => known);
  assert.ok(contraction([known, known, known, known], before, config).evidence.evaluable);
  assert.ok(!contraction([known, known, known, known], [partial, ...before.slice(1)], config).evidence.evaluable);
});
test("the candle that breaks out cannot also form the box that it breaks out of", () => {
  // The box would first qualify on the breakout candle itself (a close above the run): no box, and no decision from it.
  const r = scan({ breakout: [], after: [], inside: [], second: BOX_SECOND_HALF.slice(0, 5).concat([[159.6, 161.3, 159.6, 161.2]]) });
  assert.ok(r.boxes.every(b => b.box.high < 161));
});
test("a box's minutes must be a whole number of candles", () => {
  assert.throws(() => boxConfig(DAY, ["X"], { minBoxMinutes: 11 }), /Invalid/);
});
