import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { OrbOptionsEngine, SETTINGS, SETTING_KEYS, replayOpeningRange, validSetting, type OrbIntent, type OrbOptionsConfig } from "../src/orb-options.ts";
import { openingRangeConfig } from "../src/orb-config.ts";
import { sessionTimes } from "../src/daily-history.ts";
import { barCandleCloses, breakoutAbove, cancelLevel, rangeVsAtr, trailingAtr, newCandleState, observeCandles, protectiveStopHit, protectiveStopLevel, setupCancelled,
  stopAnchor, type CandleClose } from "../src/orb-rules.ts";

// Each rule lives once in orb-rules.ts. These tests hold every caller to the same answer on the same input, because a
// rule kept in two places drifts: one half changes and the other keeps the old behavior with its own tests still green.
// The boundary tests pin each rule outright, so a change to a rule itself fails here too.

const config: OrbOptionsConfig = { ...openingRangeConfig({ date: "2026-09-08", symbols: ["CRWV"], includePremarketLeadMinutes: 0 }),
  minimumContracts: 2, maxObservationGapMs: 60000 };
const OPEN = sessionTimes(config.date).open, END = OPEN + 120000, CANDLE = 120000;
const range = { high: 105, low: 100, startMs: OPEN, endMs: END };   // cancel level 95
const id = "00000000-0000-0000-0000-000000000001";
const candle = (close: number | null, n = 1): CandleClose => ({ start: END + (n - 1) * CANDLE, end: END + n * CANDLE, close, closeTradeAt: close === null ? null : END + n * CANDLE - 1000 });
const acts = (intents: OrbIntent[]) => intents.filter(i => i.kind !== "candle_unobserved");
/** Feed an engine one candle closing at `close` (trades every 30 s at that price, then one at the candle's end). */
const feed = (e: OrbOptionsEngine, n: number, close: number) =>
  [30000, 60000, 90000, CANDLE - 1000, CANDLE].flatMap(t => e.observe("CRWV", close, END + (n - 1) * CANDLE + t));

test("each rule's boundary is pinned outright", () => {
  const r = { high: 105, low: 100 };
  assert.equal(breakoutAbove(105, r).fired, false); assert.equal(breakoutAbove(105.01, r).fired, true);
  assert.equal(cancelLevel(r, 1), 95); assert.equal(cancelLevel(r, 0), 100); assert.equal(cancelLevel(r, 0.5), 97.5);
  assert.equal(setupCancelled(candle(95), r, 1).fired, false); assert.equal(setupCancelled(candle(94.99), r, 1).fired, true);
  assert.equal(setupCancelled(candle(null), r, 1).fired, false, "an unknown close never cancels");
  assert.equal(stopAnchor(100, null, 99.5, 98.7), 98.7); assert.equal(stopAnchor(100, 101, null), 100, "never above the range low");
  assert.equal(protectiveStopLevel(100, 0), 100); assert.equal(protectiveStopLevel(100, 0.01), 99);
  assert.equal(protectiveStopHit(candle(100), 100, 100).fired, false); assert.equal(protectiveStopHit(candle(99.99), 100, 100).fired, true);
  assert.equal(protectiveStopHit(candle(null), 100, 100).fired, false, "an unknown close never sells");
});

test("candles close on the fixed grid from the range's end, from observed trades only", () => {
  const settle = 1000, gap = 5000, closes = (st = newCandleState(END, 2)) => (p: number, t: number, o = t) => observeCandles(st, p, t, o, 2, settle, gap);
  // A trade at or after the end finishes the candle; its close is the last trade before the end.
  let seen = closes();
  assert.deepEqual(seen(101, END + 118000), []); assert.deepEqual(seen(102, END + 119500), []);
  assert.deepEqual(seen(103, END + 120000), [{ start: END, end: END + 120000, close: 102, closeTradeAt: END + 119500 }]);
  // A quiet stock: no new trade, but a fetch a poll past the end finishes it with the last trade.
  seen = closes(); seen(101, END + 117000);
  assert.deepEqual(seen(101, END + 117000, END + 120500), [], "not yet a poll past the end");
  assert.equal(seen(101, END + 117000, END + 121000)[0]?.close, 101);
  // A trade printed before the end but fetched after it is that candle's close.
  seen = closes(); seen(101, END + 116000);
  assert.equal(seen(99, END + 119900, END + 121000)[0]?.close, 99);
  // Not watching near the end: the close is unknown, never assumed; several candles crossed at once each answer for themselves.
  seen = closes(); seen(101, END + 10000);
  assert.deepEqual(seen(104, END + 3 * CANDLE + 5000).map(c => c.close), [null, null, null]);
  seen = closes(); seen(101, END + 118000);
  assert.deepEqual(seen(104, END + 2 * CANDLE + 1000).map(c => c.close), [101, null], "the first was watched to its end, the second was not");
  // An older fetch arriving late changes nothing.
  seen = closes(); seen(101, END + 119000, END + 119000);
  assert.deepEqual(seen(90, END + 118000, END + 118500), []);
  assert.equal(seen(102, END + 120000)[0]?.close, 101);
  // A 3-minute grid starts at the range's end too: no candle straddles it, none is skipped.
  const three = newCandleState(END, 3); observeCandles(three, 100, END + 179000, END + 179000, 3, settle, gap);
  assert.deepEqual(observeCandles(three, 100, END + 180000, END + 180000, 3, settle, gap).map(c => [c.start, c.end]), [[END, END + 180000]]);
});

test("a lagging feed: a candle waits the quote-age limit for trades printed before its end, so the real last trade is its close", () => {
  const st = newCandleState(END, 2), feed = (p: number, t: number, o: number) => observeCandles(st, p, t, o, 2, 5000, 5000);
  feed(101, END + 117000, END + 118000);
  assert.deepEqual(feed(101, END + 118000, END + 121000), [], "a second past the end, the feed still shows a trade from before it");
  assert.deepEqual(feed(94, END + 119500, END + 122000), [], "the real last trade arrives late");
  assert.deepEqual(feed(95, END + 120500, END + 123000).map(c => c.close), [94], "the first trade at or after the end settles it");
});
test("a stale quote, polled every second, never supplies a close: not its own trade, not as the held trade later", () => {
  // The reviewer's case: the last fresh look is 10 s before the end, then the feed lags 6 s (over the 5 s quote-age limit).
  const st = newCandleState(END, 2), see = (p: number, t: number, o: number, fresh: boolean) => observeCandles(st, p, t, o, 2, 5000, 5000, fresh);
  see(101, END + 110000, END + 110000, true);
  const out: CandleClose[] = [];
  for (let o = END + 111000; o <= END + 125000; o += 1000) out.push(...see(o - 6000 < END + 120000 ? 94 : 96, o - 6000, o, false));
  assert.deepEqual(out.map(c => c.close), [null], "a stale trade from before the end makes the close unknown, never 94");
  // A stale quote never becomes the held trade: a fresh trade after the end later finds the last FRESH trade as the
  // candidate, and the stale stretch (no fresh look within 5 s of the end) leaves it unknown.
  const st2 = newCandleState(END, 2), see2 = (p: number, t: number, o: number, fresh: boolean) => observeCandles(st2, p, t, o, 2, 5000, 5000, fresh);
  see2(101, END + 118000, END + 118000, true); see2(94, END + 119000, END + 119500, false);
  assert.deepEqual(see2(96, END + 120200, END + 120300, true).map(c => c.close), [null], "the held 101 was superseded by an untrusted 94: unknown");
});
test("the replay's bar candles agree with the candles built from the per-second path", () => {
  // A minute bar's path visits open, low, high, close; polled each second, the candle close is the last minute's close.
  const bars = Array.from({ length: 6 }, (_, i) => ({ at: END + i * 60000, close: 100 + (i % 3) - 1 }));
  const st = newCandleState(END, 2), polled: CandleClose[] = [];
  for (const b of bars) for (let sec = 0; sec < 60; sec++) {
    const price = sec === 59 ? b.close : 100 + sec / 100, t = b.at + sec * 1000;
    polled.push(...observeCandles(st, price, t, t, 2, 1000, 5000));
  }
  polled.push(...observeCandles(st, 100, END + 6 * 60000, END + 6 * 60000, 2, 1000, 5000));
  assert.deepEqual(polled.map(c => [c.end, c.close]), barCandleCloses(bars, END, 2).map(c => [c.end, c.close]));
});

test("the engine's cancel is the rule's decision, before entry, whether the candle closed while watching or while the range was pending", () => {
  for (const close of [94, 94.99, 95, 96, 99.99, 101]) {
    const decision = setupCancelled(candle(close), range, config.openingLowToleranceRanges).fired;
    const watching = new OrbOptionsEngine(config); watching.setRange("CRWV", range); feed(watching, 1, close);
    assert.equal(watching.snapshot().symbols.CRWV!.endReason === "opening_low_failed", decision, `watching, close ${close}`);
    const pending = new OrbOptionsEngine(config); feed(pending, 1, close); pending.setRange("CRWV", range);
    assert.equal(pending.snapshot().symbols.CRWV!.endReason === "opening_low_failed", decision, `pending, close ${close}`);
    // The replay's bar reading of the same candle.
    const bar = (minute: number, c: number) => ({ begins_at: new Date(minute * 60000).toISOString(), high_price: String(Math.max(c, 103)), low_price: String(Math.min(c, 100)),
      open_price: String(c), close_price: String(c), session: "reg" });
    const raw = { data: { results: [{ symbol: "CRWV", interval: "minute", bounds: "regular", bars: [bar(0, 102), { ...bar(1, 104), high_price: "105" }, bar(2, close), bar(3, close)] }] } };
    assert.equal(replayOpeningRange(raw, "CRWV", 0).outcome === "disqualified", decision, `replay, close ${close}`);
  }
});

test("the engine's protective stop is the rule's decision on each candle after entry", () => {
  for (const close of [98, 99.89, 99.9, 99.91, 100, 104]) {
    const e = new OrbOptionsEngine(config); e.setRange("CRWV", range);
    assert.equal(acts(e.observe("CRWV", 106, END + 1000))[0]?.kind, "enter_calls"); e.confirmEntry("CRWV", id, 4, 106, 4, 2);
    const p = e.snapshot().symbols.CRWV!.position!, decision = protectiveStopHit(candle(close), p.stopLevel, p.stopAnchor).fired;
    const sold = acts(feed(e, 1, close)).some(i => i.kind === "sell_to_close" && i.reason === "protective_stop");
    assert.equal(sold, decision, `close ${close} against ${p.stopLevel}`);
  }
});

test("the engine's breakout is the rule's decision", () => {
  for (const price of [104.99, 105, 105.01, 106]) {
    const e = new OrbOptionsEngine(config); e.setRange("CRWV", range);
    assert.equal(acts(e.observe("CRWV", price, END + 1000))[0]?.kind === "enter_calls", breakoutAbove(price, range).fired, `breakout at ${price}`);
  }
});

test("every settings row checks its own range and integer-ness", () => {
  for (const key of SETTING_KEYS) {
    const row = SETTINGS[key], step = row.integer ? 1 : Math.max(row.min, 0.001);
    assert.ok(validSetting(key, row.min) && validSetting(key, row.max), `${key} accepts its bounds`);
    assert.ok(!validSetting(key, row.min - step) && !validSetting(key, row.max + step), `${key} rejects beyond its bounds`);
    assert.equal(validSetting(key, null), row.default === null, `${key} null only where the default is null`);
    if (row.integer) assert.ok(!validSetting(key, row.min + 0.5), `${key} must be whole`);
  }
});

test("every settings row has a default the config pins and a unique chat name", () => {
  const names = SETTING_KEYS.map(k => SETTINGS[k].mcp.name);
  assert.equal(new Set(names).size, names.length);
  const defaults = openingRangeConfig({ date: "2026-09-08", symbols: ["CRWV"], includePremarketLeadMinutes: 0 });
  for (const key of SETTING_KEYS) assert.equal(defaults[key], SETTINGS[key].default, `${key} default`);
});

test("a saved run's config hash does not move: same settings, same JSON, key for key", () => {
  // Pinned at strategy 0.10.0's defaults: the 0.9.0 key order, then each new setting appended. A changed hash makes
  // re-configuring a saved run ID with identical settings fail as "different settings".
  const json = JSON.stringify(openingRangeConfig({ date: "2026-09-14", symbols: ["CRWV", "NOW"], includePremarketLeadMinutes: 0 }));
  assert.equal(createHash("sha256").update(json).digest("hex"), "17ad250ae9b4c7d60e1ec70bd171f7d7f66a432742a3146fcfc6e532921ee558");
});

test("each settings row's chat unit is pinned, so a mislabelled unit cannot pass the round trip", () => {
  assert.deepEqual(Object.fromEntries(SETTING_KEYS.map(k => [k, SETTINGS[k].mcp.unit])), {
    entryWindowMinutes: "whole", budgetCentsPerPosition: "dollars", budgetCentsPerDay: "dollars", minimumContracts: "whole",
    maximumContractsPerTrade: "whole", maximumPositions: "whole", maxOptionSpreadFraction: "percent", feeReserveCentsPerContract: "whole",
    firstTargetMultiple: "multiple", middleTargetMultiple: "multiple", finalTargetMultiple: "multiple", backstopFraction: "percent",
    stopBufferFraction: "percent", flattenLeadMinutes: "whole", pollMs: "seconds", maxQuoteAgeMs: "seconds", maxObservationGapMs: "seconds",
    rangeDeadlineMs: "seconds", maxEntryQuoteBatches: "whole", maxEntryAttempts: "whole", heartbeatMs: "seconds", readFailureHaltMs: "seconds",
    openingLowToleranceRanges: "multiple", candleMinutes: "whole" });
});

test("ATR is the mean of the last 14 true ranges, as the levels engine measures it, and the range is a share of it", () => {
  const bars = Array.from({ length: 15 }, (_, i) => ({ high: 106, low: 102, close: i === 13 ? 100 : 104 }));
  // The 14 true ranges: 4 each, except the bar after the 100 close (106 - 100 = 6).
  assert.equal(trailingAtr(bars), (13 * 4 + 6) / 14);
  assert.equal(trailingAtr(bars.slice(1)), null, "needs 15 sessions for 14 true ranges");
  assert.deepEqual(rangeVsAtr({ high: 105, low: 100 }, 4), { atr14: 4, rangeToAtr: 1.25 });
  assert.deepEqual(rangeVsAtr({ high: 105, low: 100 }, null), { atr14: null, rangeToAtr: null });
});
