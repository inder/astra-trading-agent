import { test } from "node:test";
import assert from "node:assert/strict";
import { BOX_SETTINGS, BOX_SETTING_KEYS, boxConfig, parseBoxConfig } from "../src/box-settings.ts";
import { anchoredVwaps, barCandles, beforeBox, contraction, prepareDay, supportCluster, runawayGate, scanDay, sizedEntry, type Support, staticSupports, supportUnderBox, vwapBars, type Candle } from "../src/box-rules.ts";
import { barCandleCloses } from "../src/orb-rules.ts";
import { sessionTimes } from "../src/daily-history.ts";
import { BOX_FIRST_HALF, BOX_SECOND_HALF, BREAKOUT, DAY, INSIDE_AFTER, PRE_BOX, laggardDailies, referenceBars, runawayDailies } from "./box-fixture.ts";

// Every price here is invented, shaped like SOXL, RKT and IBM on 2026-10-05. Times are New York wall clock (the box
// 9:46 to 10:14, the first close above it on the candle that closes at 10:16); a candle is named by its start.
const config = boxConfig(DAY, ["SOXL"]), gated = boxConfig(DAY, ["SOXL"], { useRunawayGate: 1 });
const et = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit" });
const scan = (o = {}, c = config, daily = runawayDailies()) => scanDay(referenceBars(o), daily, c);

test("settings: every number is a row with the founder's placeholder default, and out-of-range or unknown values are refused", () => {
  const d = Object.fromEntries(BOX_SETTING_KEYS.map(k => [k, BOX_SETTINGS[k].default]));
  assert.equal(d.maxBoxHeightAtr, 0.25); assert.equal(d.minBoxMinutes, 10); assert.equal(d.supportReachAtr, 0.08); assert.equal(d.contractionBaseline, 1); assert.deepEqual([d.averageSupportFastPeriod, d.averageSupportShortPeriod, d.averageSupportLongPeriod, d.averageSupportKind], [10, 20, 21, 2]); assert.equal(d.supportSlackAtr, 0); assert.equal(d.contractionMaxRatio, 0.8); assert.equal(d.useRunawayGate, 0, "the watchlist is the runaway list: the gate is off unless asked for");
  assert.equal(d.contractionLookbackCandles, 5); assert.equal(d.riskCents, 50_000); assert.equal(d.breakoutLookbackSessions, 10); assert.equal(d.maxBelowHighFraction, 0.1);
  assert.equal(parseBoxConfig(config).symbols[0], "SOXL");
  assert.throws(() => boxConfig(DAY, ["SOXL"], { maxBoxHeightAtr: 5 }), /Invalid/);
  assert.throws(() => boxConfig(DAY, ["SOXL"], { minBoxMinutes: 3 }), /Invalid/, "a box shorter than two candles has no second half");
  assert.throws(() => boxConfig(DAY, ["SOXL"], { shortAveragePeriod: 30 }), /Invalid/, "the short average must be shorter than the long one");
  assert.throws(() => parseBoxConfig({ ...config, surprise: 1 }), /Invalid/);
  assert.throws(() => boxConfig(DAY, ["SOXL"], { minCandleTrades: 100, pollMs: 2000 }), /Invalid/, "a 2-minute candle at a 2-second poll cannot hold 100 distinct trades");
  assert.ok(boxConfig(DAY, ["SOXL"], { minCandleTrades: 60, pollMs: 2000 }), "60 polls fit in 120 seconds");
});

test("a runaway stock passes the gate, and the journal shows every check with its numbers", () => {
  const g = runawayGate(runawayDailies(), gated);
  assert.ok(g.fired);
  assert.deepEqual((g.evidence.checks as any[]).map(c => [c.name, c.pass]), [["shortAverage", true], ["longAverage", true], ["nearHigh", true], ["brokeResistance", true]]);
});
test("a stock below its averages, far under its high, with nothing broken (RKT, IBM shaped) fails every check", () => {
  const g = runawayGate(laggardDailies(), gated);
  assert.ok(!g.fired); assert.ok((g.evidence.checks as any[]).every(c => !c.pass));
  const s = scanDay(referenceBars(), laggardDailies(), gated);
  assert.equal(s.status, "not_runaway"); assert.deepEqual(s.boxes, []);
});
test("the runaway gate is optional and off by default: with it off a stock that fails every check is scanned, and never called a runaway; with it on it is rejected", () => {
  const off = scanDay(referenceBars(), laggardDailies(), config);
  assert.deepEqual([off.status, off.gate, off.runaway], ["scanned", "off", null]);
  const on = scanDay(referenceBars(), laggardDailies(), gated);
  assert.deepEqual([on.status, on.gate, on.runaway?.fired], ["not_runaway", "on", false]);
  const head = prepareDay(laggardDailies(), config);
  assert.deepEqual([head.gate, head.runaway, head.unavailable], ["off", null, null]);
  assert.ok(head.atr !== null && !(head.supports.some(s => (s.kind as string) === "runaway")));
});
test("history that is stale or too short is unavailable (with its reason), never a failed gate, with the gate on or off", () => {
  const d = runawayDailies(), n = d.close.length;
  const cut = (k: number, drop = 0) => ({ time: d.time.slice(n - k - drop, n - drop), open: d.open.slice(n - k - drop, n - drop), high: d.high.slice(n - k - drop, n - drop), low: d.low.slice(n - k - drop, n - drop), close: d.close.slice(n - k - drop, n - drop) });
  for (const c of [config, gated]) {
    const stale = prepareDay(cut(60, 1), c);   // history ends the session before the previous one
    assert.equal(stale.unavailable?.reason, "stale_daily_history"); assert.equal(stale.runaway, null);
    assert.equal(scanDay(referenceBars(), cut(60, 1), c).status, "unavailable");
  }
  assert.equal(prepareDay(cut(40), gated).unavailable?.reason, "not_enough_daily_history");
  assert.equal(prepareDay(cut(10), config).unavailable?.reason, "no_atr", "ten sessions cannot give a 14-session ATR, so no box");
  assert.equal(prepareDay(cut(40), config).unavailable, null, "with the gate off, 40 sessions are enough for what the scan needs");
  const none = scanDay(referenceBars(), cut(10), config);
  assert.deepEqual([none.status, none.unavailable?.reason, none.boxes], ["unavailable", "no_atr", []]);
});
test("near misses: a close more than the allowed distance under the high fails; a break older than the lookback fails", () => {
  const d = runawayDailies(), n = d.close.length;
  const far = { ...d, close: [...d.close.slice(0, n - 1), 140] };
  assert.ok(!(runawayGate(far, config).evidence.checks as any[]).find(c => c.name === "nearHigh").pass);
  const old = runawayGate(d, boxConfig(DAY, ["SOXL"], { breakoutLookbackSessions: 1 }));
  assert.ok(!old.fired); assert.ok(!(old.evidence.checks as any[]).find(c => c.name === "brokeResistance").pass);
  const last = (k: number) => ({ time: d.time.slice(-k), open: d.open.slice(-k), high: d.high.slice(-k), low: d.low.slice(-k), close: d.close.slice(-k) });
  const short = runawayGate(last(40), config);   // a stock with 40 sessions has not shown a three-month high
  assert.deepEqual([short.fired, short.reason], [false, "unavailable"]); assert.equal((short as { unavailable: string }).unavailable, "not_enough_daily_history");
  const stale = runawayGate({ ...d, time: d.time.map((t, i) => i === n - 1 ? "2026-10-01" : t) }, config);   // the feed lags a session
  assert.deepEqual([stale.fired, stale.reason], [false, "unavailable"]); assert.equal((stale as { unavailable: string }).unavailable, "stale_daily_history");
});

test("supports: the broken zone and its breakout-session high, and the averages; each type can be switched off", () => {
  const kinds = (c = config) => new Set(staticSupports(runawayDailies(), c).map(s => s.kind));
  assert.deepEqual([...kinds()].sort(), ["average", "breakout_high", "broken_resistance"]);
  assert.deepEqual([...kinds(boxConfig(DAY, ["X"], { useAverages: 0, useBrokenResistance: 0 }))], []);
});
test("an anchored VWAP is the volume-weighted typical price from that session's open, and never reads a minute that had not finished", () => {
  const daily = runawayDailies(), bars = vwapBars(referenceBars()), { open } = sessionTimes(DAY);
  const at = (asOf: number, c = config) => anchoredVwaps(bars, daily, c, asOf);
  // Through the prior close only: Oct 1 (typical 153.5) and Oct 2 (typical 162), equal volume, so 157.75.
  const prior = at(open, boxConfig(DAY, ["X"], { vwapIncludesToday: 0 })).find(s => s.label.includes("10-01"))!;
  assert.ok(Math.abs(prior.lo - 157.75) < 0.001, `${prior.lo}`);
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

test("the reference day: one box, 9:46 to 10:14, floor 158.08, high 160.22, height 0.19 ATR, volatility shrinking, first close above it ends (closes) at 10:16", () => {
  const s = scan();
  assert.equal(s.status, "scanned"); assert.equal(s.boxes.length, 1);
  const b = s.boxes[0]!;
  assert.equal(b.status, "decided");
  assert.deepEqual([et(b.box.start), et(b.box.end)], ["09:46", "10:14"]);
  assert.equal(b.box.low, 158.08); assert.equal(b.box.high, 160.22); assert.equal(b.box.height, 2.14);
  assert.ok(Math.abs(b.box.heightToAtr - 2.14 / s.atr!) < 0.001 && b.box.heightToAtr < 0.25 && b.box.heightToAtr > 0.17, `${b.box.heightToAtr}`);
  // Measured against the session so far (the default since INTC 2026-10-06), the box is well under the 0.8 limit.
  const ratio = (b.contraction as any).ratio as number;
  assert.ok(ratio > 0.5 && ratio <= 0.7 && (b.contraction as any).evaluable, `${ratio}`);
  // Against only the five candles before it, the founder's real bars gave about 0.75: over the old 0.7 limit, under 0.8.
  const local = scan({}, boxConfig(DAY, ["X"], { contractionBaseline: 0 })).boxes[0]!, localRatio = (local.contraction as any).ratio as number;
  assert.ok(localRatio > 0.7 && localRatio <= 0.8, `${localRatio}`);
  assert.deepEqual([b.decision!.direction, et(b.decision!.candleStart), et(b.decision!.candleEnd), b.decision!.close], ["up", "10:14", "10:16", 160.71]);
  assert.equal(scan({}, boxConfig(DAY, ["X"], { contractionMaxRatio: 0.7, contractionBaseline: 0 })).boxes.filter(x => x.box.height === 2.14).length, 0, "at the old 0.7, against the candles just before it, this box is not found");
  assert.equal((b.support as any).kind, "anchored_vwap");
  // Against the session so far the box is quiet enough to form at the first bottom (158.15); the second (158.08) then extends it.
  assert.equal(b.lowAtFormation, 158.15, "the support was judged against the low the box had when it formed");
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
  const tooEarly = scan({ pre: PRE_BOX.slice(4) }).boxes.filter(b => b.box.height === 2.14);   // only three candles before the box
  assert.deepEqual(tooEarly, [], "fewer than five candles before the box means contraction cannot be judged, so no box");
});

test("near miss: a box a hair too tall is rejected, a hair shorter is accepted", () => {
  const s = scan(), ratio = 2.14 / s.atr!;
  // The height rule does not depend on the contraction baseline; the local one keeps this fixture's later, shorter box.
  const tooTall = scan({}, boxConfig(DAY, ["X"], { maxBoxHeightAtr: Math.round((ratio - 0.003) * 1e3) / 1e3, contractionBaseline: 0 }));
  // The 2.14-tall box is not accepted. A shorter one, starting later (after the first candle that would make it too tall), still forms.
  assert.ok(tooTall.boxes.length >= 1 && tooTall.boxes.every(b => b.box.height < 2.14 && et(b.box.start) !== "09:46"));
  assert.equal(scan({}, boxConfig(DAY, ["X"], { maxBoxHeightAtr: Math.round((ratio + 0.003) * 1e3) / 1e3 })).boxes.length, 1);
});
test("near miss: no contraction (the second half is as busy as the five candles before it) is rejected", () => {
  const busier = BOX_SECOND_HALF.map(([o, h, l, c]) => [o, Math.min(h + 0.3, 160.22), Math.max(l - 0.3, 158.08), c] as [number, number, number, number]);
  assert.equal(scan({}).boxes.filter(b => b.box.height === 2.14).length, 1, "the real second half passes the default 0.8");
  assert.equal(scan({ second: busier }).boxes.filter(b => b.box.height === 2.14).length, 0);
  const flat = (r: number): Candle[] => Array.from({ length: 4 }, (_, i) => ({ start: i, end: i + 1, high: 10 + r, low: 10, close: 10 }));
  assert.ok(!contraction(flat(1), flat(1).concat(flat(1)), config).fired);
  assert.ok(contraction(flat(0.5), flat(1).concat(flat(1)), config).fired);
});
test("near miss: a box whose only support sits above it is rejected: a level above the box low is resistance, never its support", () => {
  // The only VWAPs anywhere near are at 175, above the box; the other supports are switched off.
  assert.equal(scan({ priorTypical: [175, 175, 175] }, boxConfig(DAY, ["X"], { useAverages: 0, useBrokenResistance: 0 })).boxes.length, 0);
  const at = (low: number, supports: Support[] = [{ kind: "average", label: "x", lo: 100, hi: 100 }], c = config) => supportUnderBox(low, supports, 10, c).fired;
  assert.ok(at(100), "a support exactly at the box low counts"); assert.ok(at(100.8), "within the reach (0.08 ATR = 0.8) above it");
  assert.ok(!at(99.99), "a support one cent above the box low is not its support"); assert.ok(!at(99.5), "a support half a point above");
  assert.ok(at(99.5, [{ kind: "average", label: "x", lo: 100, hi: 100 }], boxConfig(DAY, ["X"], { supportSlackAtr: 0.1 })), "slack is the founder's only tolerance for one above");
  assert.ok(!at(100.81), "just past the reach");
  const zone: Support[] = [{ kind: "broken_resistance", label: "zone", lo: 98, hi: 102 }];
  assert.ok(at(100, zone), "a box low inside a support zone rests on it"); assert.ok(at(102.7, zone) && !at(102.9, zone), "reach is measured from the zone's top");
  assert.ok(!at(97.5, zone), "a zone entirely above the box low is not a support");
});
test("near miss: a box 0.12 ATR above its nearest support is rejected, and one 0.05 ATR above it is accepted (the founder's real supports were 0.04 and 0.05 ATR below)", () => {
  const s = scan(), atr = s.atr!, box = s.boxes[0]!, low = box.box.low;
  // Put the Oct 1 VWAP exactly `gap` ATRs under the box low by shifting the prior sessions' typical price.
  const vwapFor = (gap: number) => { const want = low - gap * atr, base = scanDay(referenceBars(), runawayDailies(), config).supports.find(x => x.label.includes("10-01"))!.lo; return want - base; };
  const run = (gap: number) => { const shift = vwapFor(gap); return scan({ priorTypical: [150, 153.5 + shift, 162 + shift] }, boxConfig(DAY, ["X"], { useBrokenResistance: 0, useAverages: 0, vwapMaxSessionsBack: 2 })); };
  assert.equal(run(0.12).boxes.filter(b => b.box.height === 2.14).length, 0);
  assert.equal(run(0.05).boxes.filter(b => b.box.height === 2.14).length, 1);
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
  const second = BOX_SECOND_HALF.map(c => [...c] as [number, number, number, number]); second[6] = [159.6, 159.95, 154.0, 159.5];   // the last box candle, after the box formed
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
test("an anchored VWAP is not built when a session between its anchor and the prior close has no minute bars", () => {
  const daily = runawayDailies(), all = referenceBars();
  const without = vwapBars(all.filter(b => !b.begins_at.startsWith("2026-10-01")));   // Oct 1 missing
  const labels = anchoredVwaps(without, daily, config, sessionTimes(DAY).open).map(s => s.label);
  assert.deepEqual(labels, ["VWAP from 2026-10-02 open"], "the anchors at Oct 1 and Sep 30 both need Oct 1");
});
test("a close at a new high inside a still-tight window does not discard the window: the box still starts at 9:46", () => {
  // The reviewer's probe: the fifth box candle closes at 160.30, above the 160.22 the box had reached, yet the window is still far under the height limit.
  const first = BOX_FIRST_HALF.map(c => [...c] as [number, number, number, number]); first[4] = [159.5, 160.35, 158.85, 160.3];
  const b = scan({ first }).boxes.find(x => x.box.height >= 2.14)!;
  assert.ok(b, "a box is found"); assert.equal(et(b.box.start), "09:46"); assert.equal(b.box.high, 160.35);
  assert.deepEqual([b.status, b.decision?.direction, et(b.decision!.candleEnd)], ["decided", "up", "10:16"]);
});
test("a candle that closes beyond the run before it cannot be the candle on which the box forms; it stays in the window and the box forms on the next candle", () => {
  // The rule does not depend on the contraction baseline; the local one makes the box form on the 10:08 candle this test modifies.
  const local = boxConfig(DAY, ["X"], { contractionBaseline: 0 }), plain = scan({}, local).boxes[0]!, formedEnd = Date.parse(plain.formedAt);
  // The candle the box forms on (ending 10:08, the fourth of the second half) now closes at a new high, still inside the height limit.
  const second = BOX_SECOND_HALF.map(c => [...c] as [number, number, number, number]); second[3] = [159.9, 160.26, 159.7, 160.25];   // calm (range 0.56), so contraction and support still hold on it
  const b = scan({ second }, local).boxes.find(x => et(x.box.start) === "09:46")!;
  assert.ok(b, "the window survived");
  assert.ok(Date.parse(b.formedAt) > formedEnd, `formed at ${b.formedAt}, not on the breakout candle ending ${plain.formedAt}`);
});

// ---- The daily-average supports, the session baseline and the cluster, without private bars (INTC 2026-10-06 shaped them).
const linear = (n: number) => { const time = Array.from({ length: n }, (_, i) => new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString().slice(0, 10)), close = time.map((_, i) => i + 1);
  return { time, open: close, high: close.map(c => c + 0.5), low: close.map(c => c - 0.5), close }; };
const averages = (n: number, o: Record<string, number> = {}) => Object.fromEntries(staticSupports(linear(n), boxConfig(DAY, ["X"], { useBrokenResistance: 0, ...o }), null)
  .filter(x => x.kind === "average").map(x => [x.label, Math.round(x.lo * 1e6) / 1e6]));
test("daily averages: the 10/20/21 SMA and EMA from the closes before the day, exact on a straight line", () => {
  // Closes 1..60: an n-day SMA is 60 - (n - 1) / 2 and, on a straight line, a converged n-day EMA lags by the same (n - 1) / 2.
  assert.deepEqual(averages(60), { "10-day SMA": 55.5, "10-day EMA": 55.5, "20-day SMA": 50.5, "20-day EMA": 50.5, "21-day SMA": 50, "21-day EMA": 50 });
  assert.deepEqual(Object.keys(averages(41)), ["10-day SMA", "10-day EMA", "20-day SMA", "20-day EMA", "21-day SMA"], "an EMA needs twice its period of history: 41 sessions seed the 20 but not the 21");
  assert.deepEqual(Object.keys(averages(60, { averageSupportKind: 0 })), ["10-day SMA", "20-day SMA", "21-day SMA"]);
  assert.deepEqual(Object.keys(averages(60, { averageSupportKind: 1 })), ["10-day EMA", "20-day EMA", "21-day EMA"]);
  assert.deepEqual(Object.keys(averages(60, { averageSupportLongPeriod: 20 })), ["10-day SMA", "10-day EMA", "20-day SMA", "20-day EMA"], "equal periods are not doubled");
  assert.deepEqual(Object.keys(averages(60, { averageSupportFastPeriod: 0 })), ["20-day SMA", "20-day EMA", "21-day SMA", "21-day EMA"], "0 turns the fast average off");
  assert.deepEqual(averages(60, { useAverages: 0 }), {});
});
test("the session baseline is every observed candle since 9:32 before the box; the local one is the few just before it", () => {
  const c = (i: number, range: number, known = true): Candle => ({ start: i, end: i + 1, high: 100 + range, low: 100, close: known ? 100 : null });
  const cs = [c(0, 2), c(1, 2, false), c(2, 2), c(3, 1), c(4, 1), c(5, 1), c(6, 1), c(7, 1), c(8, 0.2)];
  assert.deepEqual(beforeBox(cs, 8, boxConfig(DAY, ["X"])).map(x => x.start), [0, 2, 3, 4, 5, 6, 7], "an unobserved candle earlier in the day is left out, never blocks");
  assert.deepEqual(beforeBox(cs, 8, boxConfig(DAY, ["X"], { contractionBaseline: 0 })).map(x => x.start), [3, 4, 5, 6, 7]);
});
test("the cluster lists every level within reach of the box low, flags the ones above it, and measures the averages' spread", () => {
  const cfg = boxConfig(DAY, ["X"]), reach = cfg.supportReachAtr * 10;   // ATR 10: reach 0.8
  const supports: Support[] = [{ kind: "average", label: "20-day SMA", lo: 99.5, hi: 99.5 }, { kind: "average", label: "20-day EMA", lo: 100.05, hi: 100.05 },
    { kind: "average", label: "21-day SMA", lo: 100 - reach - 0.01, hi: 100 - reach - 0.01 }, { kind: "anchored_vwap", label: "VWAP", lo: 102, hi: 102 }];
  const k = supportCluster(100, supports, 10, cfg);
  assert.deepEqual([k.withinReach, k.atOrBelow, k.above], [2, 1, 1]);
  assert.deepEqual(k.levels.map(l => [l.label, l.fromBoxLowAtr, l.above]), [["20-day SMA", -0.05, false], ["20-day EMA", 0.005, true]]);
  assert.equal(k.averagesSpreadAtr, 0.055, "the two averages in the cluster span 99.5..100.05; the 21-day just out of reach is not counted");
  const far: Support = { kind: "average", label: "10-day SMA", lo: 120, hi: 120 };
  assert.equal(supportCluster(100, [...supports, far], 10, cfg).averagesSpreadAtr, 0.055, "a 10-day far above the cluster does not widen it")
  assert.equal(supportCluster(100, [supports[0]!], 10, cfg).averagesSpreadAtr, null, "one average has no spread");
  const zone = supportCluster(100, [{ kind: "broken_resistance", label: "zone", lo: 99.5, hi: 101 }], 10, cfg).levels[0]!;
  assert.deepEqual([zone.above, zone.fromBoxLowAtr], [false, 0], "a zone spanning the box low: not above it, and no distance (its edge is at the low)");
  // The box's own support never comes from above: the 3-cent-higher EMA is listed, but the SMA under it is the support.
  assert.equal(supportUnderBox(100, supports, 10, cfg).support!.label, "20-day SMA");
});
test("under the default settings the reference box is rejected when the height limit is a hair lower than it", () => {
  const s = scan(), ratio = 2.14 / s.atr!;
  assert.equal(scan({}, boxConfig(DAY, ["X"], { maxBoxHeightAtr: Math.round((ratio - 0.003) * 1e3) / 1e3 })).boxes.filter(b => b.box.height === 2.14).length, 0);
});
