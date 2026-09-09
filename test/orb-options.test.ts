import { test } from "node:test";
import assert from "node:assert/strict";
import { OrbOptionsEngine, nearestPreferredExpiration, parseOpeningRange, parseOrbOptionsConfig, replayOpeningBalance,
  replayOpeningRange, replayOrbSetups, selectOrbCall, type OrbOptionsConfig } from "../src/orb-options.ts";

const config: OrbOptionsConfig = {
  date: "2026-09-08", symbols: ["CRWV", "SOXL", "MU", "INTC"], openingRangeMinutes: 2,
  stopBufferFraction: .001, budgetCentsPerPosition: 200000, minimumContracts: 2, preferredContracts: 4,
  maximumPositions: 2, trimGainFraction: .05, maximumTrimSteps: 4, feeReserveCentsPerContract: 100,
  maxOptionSpreadFraction: .2, maxQuoteAgeMs: 5000, maxObservationGapMs: 5000, pollMs: 1000,
  includePremarketLeadMinutes: 0, balanceBarMinutes: 2, balanceMinimumBars: 5, balanceMaximumBars: 30,
  balanceMaximumWidthFraction: .02, balanceBreakoutCloseLocation: .75,
};
const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const range = { high: 105, low: 100, startMs: 0, endMs: 120000 };

test("configuration locks the agreed risk and sizing rules", () => {
  assert.equal(parseOrbOptionsConfig(config).budgetCentsPerPosition, 200000);
  assert.throws(() => parseOrbOptionsConfig({ ...config, budgetCentsPerPosition: 200001 }));
  assert.throws(() => parseOrbOptionsConfig({ ...config, maximumPositions: 3 }));
  assert.throws(() => parseOrbOptionsConfig({ ...config, symbols: ["MU", "MU"] }));
});
test("two exact regular one-minute bars form the opening range", () => {
  const raw = { data: { results: [{ symbol: "CRWV", interval: "minute", bounds: "regular", bars: [
    { begins_at: "1970-01-01T00:00:00Z", high_price: "103", low_price: "100", session: "reg" },
    { begins_at: "1970-01-01T00:01:00Z", high_price: "105", low_price: "101", session: "reg" },
  ] }] } };
  assert.deepEqual(parseOpeningRange(raw, "CRWV", 0), range);
  assert.throws(() => parseOpeningRange({ data: { results: [{ symbol: "CRWV", interval: "minute", bounds: "regular", bars: [raw.data.results[0]!.bars[0]] }] } }, "CRWV", 0));
});
test("replay rejects a low breach before the high break and fails closed on ambiguous bars", () => {
  const make = (third: any) => ({ data: { results: [{ symbol: "CRWV", interval: "minute", bounds: "regular", bars: [
    { begins_at: "1970-01-01T00:00:00Z", high_price: "103", low_price: "100", session: "reg" },
    { begins_at: "1970-01-01T00:01:00Z", high_price: "105", low_price: "101", session: "reg" }, third] }] } });
  assert.equal(replayOpeningRange(make({ begins_at: "1970-01-01T00:02:00Z", high_price: "104", low_price: "99", session: "reg" }), "CRWV", 0).outcome, "disqualified");
  assert.equal(replayOpeningRange(make({ begins_at: "1970-01-01T00:02:00Z", high_price: "106", low_price: "99", session: "reg" }), "CRWV", 0).outcome, "ambiguous");
  assert.equal(replayOpeningRange(make({ begins_at: "1970-01-01T00:02:00Z", high_price: "106", low_price: "101", session: "reg" }), "CRWV", 0).outcome, "qualified");
});
const pair = (minute: number, open: number, high: number, low: number, close: number) => [
  { begins_at: new Date(minute * 60000).toISOString(), open_price: String(open), high_price: String(high), low_price: String(low), close_price: String((open + close) / 2), volume: "100", session: "reg" },
  { begins_at: new Date((minute + 1) * 60000).toISOString(), open_price: String((open + close) / 2), high_price: String(high), low_price: String(low), close_price: String(close), volume: "100", session: "reg" },
];
test("drive-then-balance ignores the opening wick and requires a strong completed-bar breakout", () => {
  const bars = [
    ...pair(0, 100, 110, 99, 101), ...pair(2, 101, 101.2, 99.9, 100.8), ...pair(4, 100.8, 101.1, 99.8, 100.5),
    ...pair(6, 100.5, 101.3, 99.7, 100.9), ...pair(8, 100.9, 101.2, 99.6, 100.7), ...pair(10, 100.7, 101.8, 100.5, 101.7),
  ];
  const raw = { data: { results: [{ symbol: "INTC", interval: "minute", bounds: "regular", bars }] } };
  const result = replayOpeningBalance(raw, "INTC", 0, { ...config, symbols: ["INTC"] });
  assert.equal(result.outcome, "qualified"); assert.equal(result.range?.high, 101.3); assert.equal(result.eventPrice, 101.7);
  const combined = replayOrbSetups(raw, "INTC", 0, { ...config, symbols: ["INTC"] });
  assert.equal(combined.openingRange.outcome, "no_event"); assert.equal(combined.selectedSetup, "opening_balance");
});
test("opening balance fails when the post-open battle stops being tight", () => {
  const bars = [...pair(0, 100, 110, 99, 101), ...pair(2, 101, 103, 98, 100)];
  const raw = { data: { results: [{ symbol: "INTC", interval: "minute", bounds: "regular", bars }] } };
  assert.equal(replayOpeningBalance(raw, "INTC", 0, { ...config, symbols: ["INTC"] }).outcome, "disqualified");
});
test("historical lifecycle enters at the crossed range level and stops before later trims", () => {
  const bars = [
    { begins_at: "1970-01-01T00:00:00Z", open_price: "100", high_price: "103", low_price: "100", close_price: "102", volume: "100", session: "reg" },
    { begins_at: "1970-01-01T00:01:00Z", open_price: "102", high_price: "105", low_price: "101", close_price: "104", volume: "100", session: "reg" },
    { begins_at: "1970-01-01T00:02:00Z", open_price: "104", high_price: "106", low_price: "101", close_price: "105.5", volume: "100", session: "reg" },
    { begins_at: "1970-01-01T00:03:00Z", open_price: "105.5", high_price: "106", low_price: "99", close_price: "100", volume: "100", session: "reg" },
  ];
  const raw = { data: { results: [{ symbol: "CRWV", interval: "minute", bounds: "regular", bars }] } };
  const result = replayOrbSetups(raw, "CRWV", 0, { ...config, symbols: ["CRWV"] });
  assert.equal(result.entryPrice, 105); assert.equal(result.protectiveStop, 99.9); assert.equal(result.stoppedAt, bars[3]!.begins_at);
  assert.ok(result.trims.every(t => t.firstHitAt === null));
});
test("optional final premarket candle expands only the strict opening range", () => {
  const bars = [
    { begins_at: "1969-12-31T23:58:00Z", high_price: "106", low_price: "98", session: "pre" },
    { begins_at: "1969-12-31T23:59:00Z", high_price: "107", low_price: "99", session: "pre" },
    { begins_at: "1970-01-01T00:00:00Z", high_price: "103", low_price: "100", session: "reg" },
    { begins_at: "1970-01-01T00:01:00Z", high_price: "105", low_price: "101", session: "reg" },
  ];
  assert.deepEqual(parseOpeningRange({ data: { results: [{ symbol: "CRWV", interval: "minute", bounds: "extended", bars }] } }, "CRWV", 0, 2, 2),
    { high: 107, low: 98, startMs: -120000, endMs: 120000 });
});
test("nearest Friday is preferred over nearer non-Friday expiry", () => {
  assert.equal(nearestPreferredExpiration(["2026-09-09", "2026-09-11", "2026-09-18"], "2026-09-08"), "2026-09-11");
  assert.equal(nearestPreferredExpiration(["2026-09-09", "2026-09-10"], "2026-09-08"), "2026-09-09");
});
test("selector prefers four then three then two and never exceeds all-in budget", () => {
  const now = Date.parse("2026-09-08T15:00:00Z"), retrieved = new Date(now).toISOString();
  const contracts = [100, 105, 110].map((strike, i) => ({ id: id(i + 1), symbol: "CRWV", expiration: "2026-09-11", strike, multiplier: 100 as const, tickBelow: .01, tickAbove: .05, tickCutoff: 3, selloutAt: "2026-09-11T19:30:00Z" }));
  const quotes = [
    { id: id(1), bid: 8.9, ask: 9, askSize: 20, updatedAt: retrieved, retrievedAt: retrieved }, // only 2, nearest ITM
    { id: id(2), bid: 4.8, ask: 5, askSize: 20, updatedAt: retrieved, retrievedAt: retrieved }, // only 3 after fee reserve
    { id: id(3), bid: 4.7, ask: 4.8, askSize: 20, updatedAt: retrieved, retrievedAt: retrieved }, // four
  ];
  const selected = selectOrbCall(contracts, quotes, "CRWV", "2026-09-11", 104, config, now)!;
  assert.equal(selected.quantity, 4); assert.equal(selected.contract.strike, 110); assert.ok(selected.committedCents <= 200000);
  assert.equal(selectOrbCall(contracts, quotes.map(q => ({ ...q, ask: 10.01, bid: 10 })), "CRWV", "2026-09-11", 104, config, now), null);
});
test("low breach disqualifies only the strict route; first two valid breakouts reserve both global slots", () => {
  const e = new OrbOptionsEngine(config); for (const s of config.symbols) e.setRange(s, range);
  assert.deepEqual(e.observe("SOXL", 99, 120001), []);
  assert.equal(e.snapshot().symbols.SOXL!.status, "watching"); assert.equal(e.snapshot().symbols.SOXL!.strictStatus, "disqualified");
  assert.equal(e.observe("CRWV", 106, 120001)[0]?.kind, "enter_calls");
  assert.equal(e.observe("MU", 106, 120002)[0]?.kind, "enter_calls");
  assert.deepEqual(e.observe("INTC", 106, 120003), []); assert.equal(e.snapshot().symbols.INTC!.status, "skipped");
});
test("a strict-range failure can still enter through the independent opening-balance route", () => {
  const e = new OrbOptionsEngine({ ...config, symbols: ["INTC"] }); e.setRange("INTC", range);
  assert.deepEqual(e.observe("INTC", 99, 120001), []); assert.equal(e.snapshot().symbols.INTC!.status, "watching");
  const intents = e.offerOpeningBalance({ symbol: "INTC", setup: "opening_balance", range: { high: 101, low: 99, startMs: 0, endMs: 180000 },
    outcome: "qualified", eventAt: new Date(240000).toISOString(), eventPrice: 102, barsInBalance: 5 });
  assert.equal(intents[0]?.kind, "enter_calls"); assert.equal(intents[0]?.setup, "opening_balance");
});
test("one ticker with an unusable opening range can fail closed without blocking the basket", () => {
  const e = new OrbOptionsEngine({ ...config, symbols: ["INTC", "CRWV"] }); e.failRange("INTC"); e.setRange("CRWV", range);
  assert.equal(e.snapshot().symbols.INTC!.strictStatus, "disqualified"); assert.equal(e.observe("CRWV", 106, 120001)[0]?.kind, "enter_calls");
});
test("profit trims use stock gains and whole contracts for quantities two, three, and four", () => {
  for (const quantity of [2, 3, 4]) {
    const e = new OrbOptionsEngine({ ...config, symbols: ["CRWV"] }); e.setRange("CRWV", range);
    e.observe("CRWV", 106, 120001); e.confirmEntry("CRWV", id(1), quantity, 106);
    for (let step = 1; step <= quantity; step++) {
      const intent = e.observe("CRWV", 106 * (1 + .05 * step), 120001 + step) [0];
      assert.equal(intent?.kind, "sell_to_close"); assert.equal(intent?.reason, "profit_trim"); assert.equal(intent?.quantity, 1);
      e.confirmSale("CRWV", 1);
    }
    assert.equal(e.snapshot().symbols.CRWV!.status, "closed");
  }
});
test("jumping multiple stock thresholds batches trims; protective stop sells all remaining", () => {
  const e = new OrbOptionsEngine({ ...config, symbols: ["CRWV"] }); e.setRange("CRWV", range);
  e.observe("CRWV", 106, 120001); e.confirmEntry("CRWV", id(1), 4, 106);
  const trim = e.observe("CRWV", 118, 120002)[0]!; assert.equal(trim.kind, "sell_to_close"); assert.equal(trim.reason, "profit_trim"); assert.equal(trim.quantity, 2); e.confirmSale("CRWV", 2);
  const stop = e.observe("CRWV", 99.89, 120003)[0]!; assert.equal(stop.kind, "sell_to_close"); assert.equal(stop.reason, "protective_stop"); assert.equal(stop.quantity, 2);
});
test("confirmed user trims and closes remain within the open whole-contract position", () => {
  const e = new OrbOptionsEngine({ ...config, symbols: ["CRWV"] }); e.setRange("CRWV", range); const entry = e.observe("CRWV", 106, 120001)[0]!;
  assert.equal(entry.kind, "enter_calls"); e.confirmEntry("CRWV", id(1), 4, 106);
  const trim = e.requestPositionSale("CRWV", "user_trim", 1, 4, 107, 130000)[0]!;
  assert.equal(trim.kind, "sell_to_close"); assert.equal(trim.quantity, 1); assert.equal(trim.reason, "user_trim"); e.confirmSale("CRWV", 1);
  assert.deepEqual(e.requestPositionSale("CRWV", "user_close", 3, 4, 107, 131000), []);
  const close = e.requestPositionSale("CRWV", "user_close", 3, 3, 107, 132000)[0]!;
  assert.equal(close.kind, "sell_to_close"); if (close.kind === "sell_to_close") assert.equal(close.reason, "user_close");
  e.confirmSale("CRWV", 3); assert.equal(e.snapshot().symbols.CRWV?.status, "closed");
});
test("duplicate and gapped observations cannot create duplicate entries", () => {
  const e = new OrbOptionsEngine({ ...config, symbols: ["CRWV"] }); e.setRange("CRWV", range);
  assert.equal(e.observe("CRWV", 104, 120001, 120001).length, 0); assert.equal(e.observe("CRWV", 106, 120001, 121001).length, 0);
  assert.equal(e.observe("CRWV", 106, 126000, 127000).length, 0); assert.equal(e.snapshot().symbols.CRWV!.status, "disqualified");
});
test("a gap in provider trade timestamps fails closed even when polling stayed active", () => {
  const e = new OrbOptionsEngine({ ...config, symbols: ["CRWV"] }); e.setRange("CRWV", range);
  e.observe("CRWV", 104, 120001, 120001);
  for (let observed = 121001; observed <= 126001; observed += 1000) e.observe("CRWV", 104, 120001, observed);
  assert.deepEqual(e.observe("CRWV", 106, 126002, 127001), []); assert.equal(e.snapshot().symbols.CRWV!.status, "disqualified");
});
