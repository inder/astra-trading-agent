import { test } from "node:test";
import assert from "node:assert/strict";
import { OrbOptionsEngine, preferredWeeklyExpiration, parseOpeningRange, parseOrbOptionsConfig,
  replayOpeningRange, selectOrbCall, type OrbOptionsConfig } from "../src/orb-options.ts";

const config: OrbOptionsConfig = {
  date: "2026-09-08", symbols: ["CRWV", "SOXL", "MU", "INTC"], openingRangeMinutes: 2,
  stopBufferFraction: .001, budgetCentsPerPosition: 200000, budgetCentsPerDay: 400000, minimumContracts: 2, maximumContractsPerTrade: null,
  maximumPositions: 2, trimGainFraction: .05, maximumTrimSteps: 4, feeReserveCentsPerContract: 100,
  maxOptionSpreadFraction: .2, maxQuoteAgeMs: 5000, maxObservationGapMs: 5000, pollMs: 1000,
  includePremarketLeadMinutes: 0, entryWindowMinutes: 90,
};
const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const range = { high: 105, low: 100, startMs: 0, endMs: 120000 };

test("risk and sizing are user settings with validated ranges and cross-checks", () => {
  assert.equal(parseOrbOptionsConfig(config).budgetCentsPerPosition, 200000);
  assert.equal(parseOrbOptionsConfig({ ...config, budgetCentsPerPosition: 100000, budgetCentsPerDay: 100000, maximumPositions: 3 }).maximumPositions, 3);
  assert.throws(() => parseOrbOptionsConfig({ ...config, budgetCentsPerPosition: 9999 }));          // below $100
  assert.throws(() => parseOrbOptionsConfig({ ...config, budgetCentsPerDay: 199999 }));             // day cap under the trade cap
  assert.throws(() => parseOrbOptionsConfig({ ...config, budgetCentsPerPosition: 150000.5, budgetCentsPerDay: 400000 })); // not whole cents
  assert.throws(() => parseOrbOptionsConfig({ ...config, maximumPositions: 11 }));
  assert.throws(() => parseOrbOptionsConfig({ ...config, maxOptionSpreadFraction: 0.51 }));
  assert.throws(() => parseOrbOptionsConfig({ ...config, maximumContractsPerTrade: 1 }));           // below the minimum
  assert.throws(() => parseOrbOptionsConfig({ ...config, budgetCentsPerPosition: 10000, budgetCentsPerDay: 10000, minimumContracts: 100 })); // can never fit
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
test("weekly expiry ignores nearer daily expiries and never falls back to a non-target date", () => {
  assert.equal(preferredWeeklyExpiration(["2026-09-09", "2026-09-11", "2026-09-18"], "2026-09-08"), "2026-09-11");
  assert.equal(preferredWeeklyExpiration(["2026-09-09", "2026-09-10"], "2026-09-08"), null);
});
const sel = { ...config, minimumContracts: 4 };
const chain = (symbol: string, rows: [strike: number, bid: number, ask: number, askSize: number][], now: number) => {
  const at = new Date(now).toISOString();
  return {
    contracts: rows.map(([strike], i) => ({ id: id(i + 1), symbol, expiration: "2026-09-11", strike, multiplier: 100 as const, tickBelow: .01, tickAbove: .05, tickCutoff: 3, selloutAt: "2026-09-11T19:30:00Z" })),
    quotes: rows.map(([, bid, ask, askSize], i) => ({ id: id(i + 1), bid, ask, askSize, updatedAt: at, retrievedAt: at })),
  };
};
test("selector takes the strike nearest the money where at least 4 fit, then fills to the cap", () => {
  const now = Date.parse("2026-09-08T15:00:00Z");
  // Stock at 104. 105 is nearest but 4 × $5.01 > $2k; 100 is ITM at $9; 110 fits exactly 4.
  const { contracts, quotes } = chain("CRWV", [[100, 8.9, 9, 20], [105, 4.8, 5, 20], [110, 4.7, 4.8, 20]], now);
  const picked = selectOrbCall(contracts, quotes, "CRWV", "2026-09-11", 104, sel, now)!;
  assert.equal(picked.contract.strike, 110); assert.equal(picked.quantity, 4); assert.ok(picked.committedCents <= 200000);
  // A nearer strike that fits wins, filled to the cap but not past the displayed ask size.
  const withNear = chain("CRWV", [[102, 1.95, 2, 6], [110, 4.7, 4.8, 20]], now);
  assert.deepEqual([selectOrbCall(withNear.contracts, withNear.quotes, "CRWV", "2026-09-11", 104, sel, now)!.contract.strike,
    selectOrbCall(withNear.contracts, withNear.quotes, "CRWV", "2026-09-11", 104, sel, now)!.quantity], [102, 6]);
  const deep = chain("CRWV", [[102, 1.95, 2, 500]], now);
  assert.equal(selectOrbCall(deep.contracts, deep.quotes, "CRWV", "2026-09-11", 104, sel, now)!.quantity, 9);   // floor($2,000 / $201 per contract: $2.00 x 100 + $1 fee reserve)
  assert.equal(selectOrbCall(deep.contracts, deep.quotes, "CRWV", "2026-09-11", 104, { ...sel, maximumContractsPerTrade: 5 }, now)!.quantity, 5);
  // An in-the-money strike is eligible when it is nearest and fits.
  const itm = chain("CRWV", [[103, 1.45, 1.5, 50], [106, 0.95, 1, 50]], now);
  assert.equal(selectOrbCall(itm.contracts, itm.quotes, "CRWV", "2026-09-11", 104, sel, now)!.contract.strike, 103);
  // Fewer than 4 at the ask disqualifies a strike; no fallback to 3 or 2.
  const thin = chain("CRWV", [[102, 1.95, 2, 3]], now);
  assert.equal(selectOrbCall(thin.contracts, thin.quotes, "CRWV", "2026-09-11", 104, sel, now), null);
  // The caller's remaining day budget is the cap: $1,000 still fits 4 at $2.01; $500 does not.
  assert.equal(selectOrbCall(deep.contracts, deep.quotes, "CRWV", "2026-09-11", 104, sel, now, 100000)!.quantity, 4);
  assert.equal(selectOrbCall(deep.contracts, deep.quotes, "CRWV", "2026-09-11", 104, sel, now, 50000), null);
});
test("on the article's day the distance from the money follows the stock price", () => {
  // Black-Scholes calls, 3.5 days to expiry; asks carry a 2% spread. CRWV/SOXL fit 4 near the money; MU at $1,041 cannot.
  const N = (x: number) => { const t = 1 / (1 + .2316419 * Math.abs(x)), d = .3989423 * Math.exp(-x * x / 2);
    const p = d * t * (.3193815 + t * (-.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };
  const call = (S: number, K: number, v: number, T = 3.5 / 365) => { const d1 = (Math.log(S / K) + v * v * T / 2) / (v * Math.sqrt(T)); return S * N(d1) - K * N(d1 - v * Math.sqrt(T)); };
  const now = Date.parse("2026-09-08T15:00:00Z");
  const pick = (symbol: string, S: number, v: number, strikes: number[]) => {
    const rows = strikes.map(K => { const ask = Math.max(.05, Math.round(call(S, K, v) * 100) / 100); return [K, Math.round(ask * 98) / 100, ask, 50] as [number, number, number, number]; });
    const { contracts, quotes } = chain(symbol, rows, now);
    return selectOrbCall(contracts, quotes, symbol, "2026-09-11", S, { ...sel, symbols: [symbol] }, now)!;
  };
  const range = (from: number, to: number, step: number) => Array.from({ length: Math.round((to - from) / step) + 1 }, (_, i) => from + i * step);
  const crwv = pick("CRWV", 95.3, .9, range(80, 110, 1)), soxl = pick("SOXL", 125.4, .9, range(110, 140, 1)), mu = pick("MU", 1041, .6, range(950, 1150, 5));
  assert.ok(Math.abs(crwv.contract.strike - 95.3) <= 1 && crwv.quantity >= 4 && crwv.committedCents <= 200000, JSON.stringify(crwv.contract));
  assert.ok(Math.abs(soxl.contract.strike - 125.4) <= 1 && soxl.quantity >= 4 && soxl.committedCents <= 200000, JSON.stringify(soxl.contract));
  const muOtm = mu.contract.strike / 1041 - 1;
  assert.ok(muOtm > .03 && muOtm < .08 && mu.quantity >= 4 && mu.committedCents <= 200000, `MU strike ${mu.contract.strike}`);
});
test("larger positions trim proportionally so the fourth level exits fully", () => {
  const e = new OrbOptionsEngine({ ...config, symbols: ["CRWV"], maxObservationGapMs: 3_600_000 }); e.setRange("CRWV", range);
  assert.equal(e.observe("CRWV", 106, 120001)[0]?.kind, "enter_calls"); e.confirmEntry("CRWV", id(1), 8, 100);
  const sold: number[] = [];
  for (const [i, price] of [105, 110, 115, 120].entries()) {
    const intent = e.observe("CRWV", price, 130000 + i * 1000)[0];
    assert.ok(intent?.kind === "sell_to_close"); sold.push(intent.quantity); e.confirmSale("CRWV", intent.quantity);
  }
  assert.deepEqual(sold, [2, 2, 2, 2]); assert.equal(e.snapshot().symbols.CRWV!.status, "closed");
});
test("a trade beneath the opening-range low ends the day for that symbol; first two breakouts take both slots", () => {
  const e = new OrbOptionsEngine(config); for (const s of config.symbols) e.setRange(s, range);
  assert.deepEqual(e.observe("SOXL", 99, 120001), []);
  assert.equal(e.snapshot().symbols.SOXL!.status, "disqualified"); assert.equal(e.snapshot().symbols.SOXL!.endReason, "opening_low_failed");
  assert.deepEqual(e.observe("SOXL", 106, 130000), [], "a later rally does not erase the opening failure");
  assert.equal(e.observe("CRWV", 106, 120001)[0]?.kind, "enter_calls");
  assert.equal(e.observe("MU", 106, 120002)[0]?.kind, "enter_calls");
  assert.deepEqual(e.observe("INTC", 106, 120003), []); assert.equal(e.snapshot().symbols.INTC!.status, "skipped");
});
test("article-shaped days: CRWV holds its low and breaks out later; SOXL and MU lose the low first and never enter", () => {
  // Minutes after the open, one polled trade every 30 s; range 93–95.3 like CRWV on 2026-09-08.
  const at = (minutes: number) => minutes * 60000;
  const crwvRange = { high: 95.3, low: 93, startMs: 0, endMs: 120000 };
  const crwv = new OrbOptionsEngine({ ...config, symbols: ["CRWV"], maxObservationGapMs: 60000 }); crwv.setRange("CRWV", crwvRange);
  const crwvPath = [94.4, 94.1, 93.6, 94.8, 94.5, 94.9, 94.7, 95.0, 94.9, 95.1, 95.2, 95.25, 95.6];
  const crwvIntents = crwvPath.flatMap((price, i) => crwv.observe("CRWV", price, at(2 + i)));
  assert.equal(crwvIntents.length, 1); assert.equal(crwvIntents[0]!.kind, "enter_calls"); assert.equal(crwvIntents[0]!.at, at(14));
  const failing = new OrbOptionsEngine({ ...config, symbols: ["SOXL", "MU"], maxObservationGapMs: 60000 });
  failing.setRange("SOXL", { high: 126.7, low: 124.9, startMs: 0, endMs: 120000 });
  failing.setRange("MU", { high: 1041, low: 1027.7, startMs: 0, endMs: 120000 });
  const soxl = [124.6, 124.2, 123.6, 125.5, 127.0, 127.5], mu = [1020.5, 1021.1, 1025.3, 1028.0, 1027.9];
  assert.deepEqual(soxl.flatMap((p, i) => failing.observe("SOXL", p, at(2 + i))), []);
  assert.deepEqual(mu.flatMap((p, i) => failing.observe("MU", p, at(2 + i))), []);
  assert.equal(failing.snapshot().symbols.SOXL!.endReason, "opening_low_failed");
  assert.equal(failing.snapshot().symbols.MU!.endReason, "opening_low_failed");
});
test("new entries stop at the configurable window; open positions keep being managed", () => {
  const e = new OrbOptionsEngine({ ...config, symbols: ["CRWV", "MU"], entryWindowMinutes: 60, maxObservationGapMs: 3_600_000 });
  e.setRange("CRWV", range); e.setRange("MU", range);
  assert.equal(e.observe("CRWV", 106, 59 * 60000)[0]?.kind, "enter_calls");
  e.confirmEntry("CRWV", id(1), 4, 106);
  assert.deepEqual(e.observe("MU", 106, 60 * 60000), [], "a breakout at the window edge does not enter");
  assert.equal(e.snapshot().symbols.MU!.endReason, "entry_window_closed");
  const exit = e.observe("CRWV", 99.8, 61 * 60000)[0];
  assert.ok(exit?.kind === "sell_to_close" && exit.reason === "protective_stop", "the open position is still managed");
  const swept = new OrbOptionsEngine({ ...config, symbols: ["INTC"] }); swept.setRange("INTC", range);
  assert.deepEqual(swept.closeEntryWindow(89 * 60000), []); assert.deepEqual(swept.closeEntryWindow(90 * 60000), ["INTC"]);
  assert.throws(() => parseOrbOptionsConfig({ ...config, entryWindowMinutes: 4 }));
  assert.throws(() => parseOrbOptionsConfig({ ...config, entryWindowMinutes: 391 }));
  assert.throws(() => parseOrbOptionsConfig({ ...config, entryWindowMinutes: 90.5 }));
  assert.equal(parseOrbOptionsConfig({ ...config, entryWindowMinutes: 5 }).entryWindowMinutes, 5);
  assert.equal(parseOrbOptionsConfig({ ...config, entryWindowMinutes: 390 }).entryWindowMinutes, 390);
});
test("the entry window is anchored to the 9:30 open even when premarket minutes widen the range", () => {
  const e = new OrbOptionsEngine({ ...config, symbols: ["CRWV"], includePremarketLeadMinutes: 2 });
  e.setRange("CRWV", { high: 105, low: 100, startMs: -120000, endMs: 120000 });
  assert.equal(e.entryDeadline(), 90 * 60000);
});
test("engine state round-trips through a checkpoint, and a tampered checkpoint is refused", () => {
  const e = new OrbOptionsEngine({ ...config, symbols: ["CRWV", "SOXL", "MU"] });
  e.setRange("CRWV", range); e.setRange("SOXL", range); e.failRange("MU");
  e.observe("SOXL", 99, 120001);
  const saved = e.snapshot(), copy = new OrbOptionsEngine({ ...config, symbols: ["CRWV", "SOXL", "MU"] }); copy.restore(saved);
  assert.deepEqual(copy.snapshot(), saved);
  const tamper = (patch: (s: any) => void) => { const t = structuredClone(saved) as any; patch(t); return () => copy.restore(t); };
  assert.throws(tamper(t => { t.symbols.SOXL.endReason = null; }), /symbol state/);            // disqualified without a reason
  assert.throws(tamper(t => { t.symbols.CRWV.endReason = "opening_low_failed"; }), /symbol state/); // watching with a reason
  assert.throws(tamper(t => { t.symbols.MU.endReason = "made_up"; }), /symbol state/);
  assert.throws(tamper(t => { t.symbols.CRWV.openingRange = null; }), /symbol state/);          // watching without a range
});
test("one ticker with an unusable opening range can fail closed without blocking the basket", () => {
  const e = new OrbOptionsEngine({ ...config, symbols: ["INTC", "CRWV"] }); e.failRange("INTC"); e.setRange("CRWV", range);
  assert.equal(e.snapshot().symbols.INTC!.status, "disqualified"); assert.equal(e.snapshot().symbols.INTC!.endReason, "range_unavailable");
  assert.equal(e.observe("CRWV", 106, 120001)[0]?.kind, "enter_calls");
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
