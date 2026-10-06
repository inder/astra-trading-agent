import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { OrbOptionsEngine, SETTINGS, SETTING_KEYS, replayOpeningRange, validSetting, type OrbOptionsConfig } from "../src/orb-options.ts";
import { openingRangeConfig } from "../src/orb-config.ts";
import { breakevenStopHit, breakoutAbove, openingLowBroken, protectiveStopHit, protectiveStopLevel } from "../src/orb-rules.ts";

// Each rule lives once in orb-rules.ts. These tests hold every caller to the same answer on the same input, because a
// rule kept in two places drifts: one half changes and the other keeps the old behavior with its own tests still green.

const config: OrbOptionsConfig = { ...openingRangeConfig({ date: "2026-09-08", symbols: ["CRWV"], includePremarketLeadMinutes: 0 }), minimumContracts: 2 };
const range = { high: 105, low: 100, startMs: 0, endMs: 120000 };
const id = "00000000-0000-0000-0000-000000000001";
const prices = [99, 99.99, 99.9, 100, 100.01, 104.99, 105, 105.01, 106];

test("the engine's opening-low and breakout decisions are the rules' decisions", () => {
  for (const price of prices) {
    const e = new OrbOptionsEngine(config); e.setRange("CRWV", range);
    const intents = e.observe("CRWV", price, 120001), after = e.snapshot().symbols.CRWV!;
    assert.equal(after.status === "disqualified" && after.endReason === "opening_low_failed", openingLowBroken(price, range).fired, `low at ${price}`);
    assert.equal(intents[0]?.kind === "enter_calls", breakoutAbove(price, range).fired, `breakout at ${price}`);
  }
});

test("a low seen while the range bars were pending, and a reversed entry quote, use the same opening-low rule", () => {
  for (const price of prices.filter(p => p <= 105)) {
    const pending = new OrbOptionsEngine(config); pending.observe("CRWV", price, Date.parse("2026-09-08T13:32:00.500Z"));
    pending.setRange("CRWV", { ...range, startMs: Date.parse("2026-09-08T13:30:00Z"), endMs: Date.parse("2026-09-08T13:32:00Z") });
    assert.equal(pending.snapshot().symbols.CRWV!.endReason === "opening_low_failed", openingLowBroken(price, range).fired, `pending at ${price}`);
    const entry = new OrbOptionsEngine(config); entry.setRange("CRWV", range); entry.observe("CRWV", 106, 120001);
    entry.failEntry("CRWV", { newerPrice: price });
    assert.equal(entry.snapshot().symbols.CRWV!.endReason === "opening_low_failed", openingLowBroken(price, range).fired, `entry quote at ${price}`);
  }
});

test("the replay's bar outcome uses the same rules as the engine", () => {
  const bars = (high: string, low: string) => ({ data: { results: [{ symbol: "CRWV", interval: "minute", bounds: "regular", bars: [
    { begins_at: "1970-01-01T00:00:00Z", high_price: "105", low_price: "100", session: "reg" },
    { begins_at: "1970-01-01T00:01:00Z", high_price: "104", low_price: "101", session: "reg" },
    { begins_at: "1970-01-01T00:02:00Z", high_price: high, low_price: low, open_price: low, session: "reg" }] }] } });
  for (const [high, low] of [["104", "99.99"], ["104", "100"], ["105.01", "100"], ["105", "100"], ["106", "99"]] as const) {
    const outcome = replayOpeningRange(bars(high, low), "CRWV", 0).outcome;
    const up = breakoutAbove(+high, range).fired, down = openingLowBroken(+low, range).fired;
    assert.equal(outcome, up && down ? "ambiguous" : down ? "disqualified" : up ? "qualified" : "no_event", `${high}/${low}`);
  }
});

test("the engine's protective stop fires exactly where the rule says", () => {
  const level = protectiveStopLevel(range, config.stopBufferFraction);
  for (const price of [level - 0.01, level, level + 0.01, 100]) {
    const e = new OrbOptionsEngine(config); e.setRange("CRWV", range); e.observe("CRWV", 106, 120001);
    e.confirmEntry("CRWV", id, 4, 106, 4, 2);
    const intents = e.observe("CRWV", price, 121000);
    assert.equal(intents[0]?.kind === "sell_to_close" && intents[0].reason === "protective_stop", protectiveStopHit(price, level).fired, `stop at ${price}`);
  }
});

test("each rule's boundary is pinned outright, so a change to a rule itself fails here", () => {
  const r = { high: 105, low: 100 };
  assert.equal(openingLowBroken(100, r).fired, false); assert.equal(openingLowBroken(99.99, r).fired, true);
  assert.equal(breakoutAbove(105, r).fired, false); assert.equal(breakoutAbove(105.01, r).fired, true);
  assert.equal(protectiveStopLevel(r, 0.001), 99.9);
  assert.equal(protectiveStopHit(99.9, 99.9).fired, false); assert.equal(protectiveStopHit(99.89, 99.9).fired, true);
  assert.equal(breakevenStopHit(106, 106).fired, true); assert.equal(breakevenStopHit(106.01, 106).fired, false);
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
  // Pinned from main before the settings table existed (strategy 0.9.0 defaults). A changed hash makes re-configuring
  // a saved run ID with identical settings fail as "different settings".
  const json = JSON.stringify(openingRangeConfig({ date: "2026-09-14", symbols: ["CRWV", "NOW"], includePremarketLeadMinutes: 0 }));
  assert.equal(createHash("sha256").update(json).digest("hex"), "e0d18e9ab01988d17a31110724f2592e20953a2c79b151d6395eee01131c6b34");
});
