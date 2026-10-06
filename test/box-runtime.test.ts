import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TradingAgentService } from "../src/agent-service.ts";
import { BoxPaperRuntime } from "../src/box-paper-runtime.ts";
import { boxConfig } from "../src/box-settings.ts";
import { sessionTimes } from "../src/daily-history.ts";
import { ReplayMarket, type BarsFile, type MinuteBar } from "../src/replay-market.ts";
import { checkBoxes, runReplay, timeline, type ReplayResult } from "../src/replay.ts";
import { DAY, laggardDailies, referenceBars, runawayDailies } from "./box-fixture.ts";

// Invented prices only (test/box-fixture.ts): the real replay data is private and never enters this repository.
const { open } = sessionTimes(DAY), grid = open + 120000;
const root = mkdtempSync(join(tmpdir(), "astra-box-test-")); after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const file = (per: Record<string, MinuteBar[]>): BarsFile => ({ data: { results: Object.entries(per).map(([symbol, bars]) => ({ symbol, interval: "minute", bounds: "regular", bars })) } });
const settings = { heartbeatMs: 600000 };   // few revisions; the poll stays at the 1-second default the claims assume
const replay = (per: Record<string, MinuteBar[]>, daily: Record<string, ReturnType<typeof runawayDailies>> | undefined, extra: Record<string, unknown> = {}) =>
  runReplay({ date: DAY, symbols: Object.keys(per), regular: file(per), volatility: {}, barLagMs: 0, settings: { ...settings, ...extra }, dataDir: mkdtempSync(join(root, `r${n++}-`)),
    strategyId: "support-box", ...(daily ? { daily } : {}) });
const types = (r: ReplayResult, type: string, symbol?: string) => r.events.filter(e => e.type === type && (!symbol || e.data.symbol === symbol));
let shared: Promise<ReplayResult> | undefined;
const gate = { useRunawayGate: 1 };   // the gate is off by default; these tests exercise it
const reference = () => shared ??= replay({ SOXL: referenceBars(), LAGG: referenceBars() }, { SOXL: runawayDailies(), LAGG: laggardDailies() }, gate);

test("the watch-only run journals the verdicts and supports before 9:32, then the box formed and decided, and holds nothing", async () => {
  const r = await reference();
  assert.ok(r.complete && !r.halted); assert.equal(r.ordersSubmitted, 0);
  for (const type of ["universe_checked", "supports"]) assert.ok(types(r, type).every(e => e.at < grid), `${type} comes before the grid starts`);
  assert.deepEqual(types(r, "universe_checked").map(e => [e.data.symbol, e.data.status]).sort(), [["LAGG", "not_runaway"], ["SOXL", "runaway"]]);
  assert.equal(types(r, "supports", "LAGG").length, 0, "a stock that is not a runaway has no supports journaled");
  const order = r.events.filter(e => e.type.startsWith("box_")).map(e => e.type);
  assert.deepEqual(order, ["box_formed", "box_decided"]);
  const decided = types(r, "box_decided", "SOXL")[0]!.data;
  assert.deepEqual([decided.decision.direction, decided.decision.close, decided.entries.stop], ["up", 160.71, 158.08]);
  assert.ok(types(r, "box_formed", "SOXL")[0]!.at < types(r, "box_decided", "SOXL")[0]!.at);
  assert.equal(types(r, "box_formed", "SOXL")[0]!.data.rangesFrom, "observed_trades");
  assert.equal(types(r, "box_formed", "LAGG").length + types(r, "box_decided", "LAGG").length, 0);
  assert.ok(r.events.every(e => !["paper_entry", "paper_sale", "option_selection"].includes(e.type)), "no position, fill or order event exists");
});
test("the run and the offline scan of the same bars agree on every box (a plumbing check, not live fidelity: ADR 0002)", async () => {
  const r = await reference(), claims = checkBoxes(r, file({ SOXL: referenceBars(), LAGG: referenceBars() }), { SOXL: runawayDailies(), LAGG: laggardDailies() }, DAY, ["SOXL", "LAGG"], gate as never);
  assert.ok(claims.every(k => k.pass), claims.filter(k => !k.pass).map(k => `${k.id}: ${k.detail}`).join("; "));
  assert.ok(claims.some(k => k.id === "SOXL-boxes") && claims.some(k => k.id === "LAGG-no-boxes"));
  assert.ok(timeline(r).some(l => /BOX decided up/.test(l)));
});
test("a stock whose daily history cannot be read is journaled unavailable once and never scanned", async () => {
  const r = await replay({ SOXL: referenceBars() }, undefined);   // a market with no daily bars
  assert.deepEqual(types(r, "universe_checked").map(e => [e.data.status, e.data.reason]), [["unavailable", "daily_bars_not_supported"]]);
  assert.equal(types(r, "supports").length + types(r, "box_formed").length, 0);
});
test("a candle with no trades at all is journaled unobserved and voids the live box, with no decision acted on", async () => {
  const start = grid + 18 * 120000, bars = referenceBars().filter(b => { const at = Date.parse(b.begins_at); return !(at >= start && at < start + 120000); });
  const r = await replay({ SOXL: bars }, { SOXL: runawayDailies() });
  assert.ok(types(r, "candle_unobserved", "SOXL").some(e => Date.parse(e.data.candleStart) === start));
  const voided = types(r, "box_voided", "SOXL")[0]!.data;
  assert.equal(voided.voided.reason, "candle_unobserved");
  assert.equal(types(r, "box_decided").length, 0);
  const claims = checkBoxes(r, file({ SOXL: bars }), { SOXL: runawayDailies() }, DAY, ["SOXL"]).filter(k => k.id === "SOXL-boxes");
  assert.ok(claims.every(k => k.pass), claims.map(k => k.detail).join());
});
test("with a coarse poll the observed ranges differ from the bars', so the replay claim can fail", async () => {
  // 30-second polls see the bar's open and a mid-path price, never its low, high or close; this shows the claim is not vacuous.
  const r = await replay({ SOXL: referenceBars() }, { SOXL: runawayDailies() }, { pollMs: 30000, maxQuoteAgeMs: 30000, maxObservationGapMs: 60000 });
  const claims = checkBoxes(r, file({ SOXL: referenceBars() }), { SOXL: runawayDailies() }, DAY, ["SOXL"]);
  assert.equal(claims.find(k => k.id === "SOXL-boxes")?.pass, false, claims.map(k => k.detail).join(" / "));
});

test("the strategy previews with defaults in a canonical order, refuses foreign settings and pre-market bars, and is listed after the opening-range one", () => {
  const dir = mkdtempSync(join(root, "svc-")), service = new TradingAgentService(dir, undefined, undefined, { market: new ReplayMarket({ regular: file({}), clock: () => open, volatility: {} }), clock: () => open, ready: () => true, auto: false });
  try {
    const strategy = service.strategies.find(s => s.id === "support-box")!;
    const a = strategy.preview({ date: DAY, symbols: ["SOXL"], includePremarketLeadMinutes: 0, maxBoxHeightAtr: undefined } as never);
    assert.deepEqual(a, boxConfig(DAY, ["SOXL"]));
    assert.equal(JSON.stringify(a), JSON.stringify(strategy.preview({ date: DAY, symbols: ["SOXL"], includePremarketLeadMinutes: 0, riskCents: 50_000 } as never)));
    assert.throws(() => strategy.preview({ date: DAY, symbols: ["SOXL"], includePremarketLeadMinutes: 2 } as never), /pre-market/);
    assert.throws(() => strategy.preview({ date: DAY, symbols: ["SOXL"], includePremarketLeadMinutes: 0, firstTargetMultiple: 2 } as never), /does not apply/);
    assert.equal(service.strategies[0]!.id, "opening-range-options");
    const sample = service.runSample({ strategyId: "support-box", symbols: ["DEMO"], includePremarket: false, requestId: "box-sample" });
    assert.equal(sample.summary.ordersSubmitted, 0); assert.ok((sample.summary as any).boxes.length === 1);
  } finally { void service.close(); }
});
test("a support-box run cannot be resumed and its runtime refuses a checkpoint or a position change", async () => {
  const market = new ReplayMarket({ regular: file({}), clock: () => open, volatility: {} });
  assert.throws(() => new BoxPaperRuntime(boxConfig(DAY, ["SOXL"]), market, () => open, { complete: false }), /cannot be resumed/);
  await assert.rejects(new BoxPaperRuntime(boxConfig(DAY, ["SOXL"]), market, () => open).control({ symbol: "SOXL", quantity: 1, expectedQuantity: 1, action: "close" }), /no positions/);
});

// ---- Detached reads that fail, stall or arrive late (the happy path above answers instantly).
async function flaky(tweak: (market: ReplayMarket) => void, gated = true, extra: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(root, `fl${n++}-`)), { close } = sessionTimes(DAY);
  let now = open - 120000;
  const market = new ReplayMarket({ regular: file({ SOXL: referenceBars() }), clock: () => now, volatility: {}, daily: { SOXL: runawayDailies() } });
  tweak(market);
  const service = new TradingAgentService(dir, undefined, undefined, { market, clock: () => now, ready: () => true, auto: false });
  try {
    service.paper.configure({ runId: "flaky", strategyId: "support-box", date: DAY, symbols: ["SOXL"], includePremarket: false, heartbeatMs: 600000, ...(gated ? { useRunawayGate: 1 } : {}), ...extra } as never);
    await service.paper.start("flaky");
    for (let guard = 0; guard < 30000; guard++) { const s = await service.paper.tick("flaky"); if (s.status === "completed") break; now += 1000; if (now > close + 3600000) break; }
    const events: Journal[] = [];
    for (let after = -1; ;) { const pages = service.paper.events("flaky", after, 100); if (!pages.length) break; for (const p of pages) { for (const e of p.events) events.push({ at: Date.parse(p.at), type: e.type, data: e.data }); after = p.revision; } }
    return events;
  } finally { await service.close(); }
}
type Journal = { at: number; type: string; data: any };
const of = (events: Journal[], type: string) => events.filter(e => e.type === type);
test("a daily-history read that fails twice is tried again before 9:32 and the stock is still scanned", async () => {
  let failures = 2;
  const events = await flaky(m => { const real = m.dailyBars!; m.dailyBars = async (...a) => { if (failures-- > 0) throw new Error("429 too many requests"); return real.apply(m, a); }; });
  assert.deepEqual(of(events, "universe_checked").map(e => e.data.status), ["runaway"]);
  assert.equal(of(events, "box_decided").length, 1);
});
test("a daily-history read that never answers is settled at 9:32 as not read before the open, once, and the stock is never scanned", async () => {
  const events = await flaky(m => { m.dailyBars = () => new Promise(() => {}); });
  assert.deepEqual(of(events, "universe_checked").map(e => [e.data.status, e.data.reason]), [["unavailable", "not_read_before_open"]]);
  assert.ok(of(events, "universe_checked")[0]!.at >= grid);
  assert.equal(of(events, "box_formed").length + of(events, "supports").length, 0);
});
test("a prior session's minute bars that cannot be read are named as missing anchors; the supports still go out and the stock is scanned", async () => {
  const events = await flaky(m => { const real = m.bars.bind(m); m.bars = async (s, a, b, x) => { if (b - a > 6 * 3600000 && new Date(a).toISOString().startsWith("2026-10-01")) throw new Error("boom"); return real(s, a, b, x); }; });
  const supports = of(events, "supports")[0]!.data;
  assert.deepEqual(supports.vwapAnchorsMissing, ["2026-10-01"]);   // and the VWAP from 09-30, which needs that session too, is not built
  assert.deepEqual(supports.supports.filter((x: any) => x.kind === "anchored_vwap").map((x: any) => x.label), ["VWAP from 2026-10-02 open"]);
});
test("today's minute bars failing twice, then answering, wait the box candle out without degrading the VWAP", async () => {
  let failures = 2;
  const events = await flaky(m => { const real = m.bars.bind(m); m.bars = async (s, a, b, x) => { if (a === open && failures-- > 0) throw new Error("timeout"); return real(s, a, b, x); }; });
  const formed = of(events, "box_formed")[0]!.data;
  assert.equal(formed.vwapTodayDegraded, false); assert.ok(formed.vwapThrough);
  assert.equal(of(events, "box_decided")[0]!.data.decision.close, 160.71);
});
test("today's minute bars that never come degrade the box's VWAP to the prior sessions after three tries, and say so", async () => {
  const events = await flaky(m => { const real = m.bars.bind(m); m.bars = async (s, a, b, x) => { if (a === open) throw new Error("down"); return real(s, a, b, x); }; });
  assert.equal(of(events, "box_formed")[0]!.data.vwapTodayDegraded, true);
  assert.ok(of(events, "data_gap").some(e => e.data.source === "bars"));
});

/** A feed that shows a new trade on only one poll in three (the others repeat the last one): about 40 distinct trades in a 2-minute candle. */
const slowTape = (m: ReplayMarket) => { const real = m.quotes.bind(m); let calls = 0, held: Awaited<ReturnType<typeof real>> = []; m.quotes = async s => (calls++ % 3 === 0 ? (held = await real(s)) : held); };
test("a candle seen through too few distinct trades has no known close (ADR 0002), however steady the price", async () => {
  const sparse = await flaky(slowTape, true, { minCandleTrades: 50 });
  assert.equal(of(sparse, "box_formed").length, 0);
  const unobserved = of(sparse, "candle_unobserved");
  assert.ok(unobserved.length > 0 && unobserved.every(e => e.data.reason === "sparse" && e.data.distinctTrades < 50 && e.data.distinctTrades >= 30), JSON.stringify(unobserved[0]?.data));
  const enough = await flaky(slowTape, true, { minCandleTrades: 30 });
  assert.equal(of(enough, "candle_unobserved").length, 0); assert.equal(of(enough, "box_decided").length, 1);
});
test("with the gate off (the default) a stock is journaled as watched, never as a runaway, and is scanned", async () => {
  const events = await flaky(() => {}, false);
  const verdict = of(events, "universe_checked")[0]!.data;
  assert.deepEqual([verdict.status, verdict.runaway, verdict.runawayGate], ["watched", null, "off"]);
  assert.ok(!events.some(e => e.type === "universe_checked" && e.data.runaway === true));
  assert.equal(of(events, "box_decided").length, 1);
});
test("daily history that ends before the previous session is unavailable with its reason, after being read again until 9:32, and never a not-runaway verdict", async () => {
  let reads = 0;
  const events = await flaky(m => { const real = m.dailyBars!; m.dailyBars = async (...a) => { reads++; const r = await real.apply(m, a), b = r.bars, n = b.time.length - 1; return { ...r, bars: { time: b.time.slice(0, n), open: b.open.slice(0, n), high: b.high.slice(0, n), low: b.low.slice(0, n), close: b.close.slice(0, n) } }; }; });
  assert.deepEqual(of(events, "universe_checked").map(e => [e.data.status, e.data.reason]), [["unavailable", "stale_daily_history"]]);
  assert.ok(reads >= 2, "a lagging feed is read again before the gate settles it");
  assert.equal(of(events, "box_formed").length, 0);
});
test("today's minute bars failing three times degrade the VWAP, and a later success restores it", async () => {
  let failures = 3;
  const events = await flaky(m => { const real = m.bars.bind(m); m.bars = async (s, a, b, x) => { if (a === open && failures-- > 0) throw new Error("timeout"); return real(s, a, b, x); }; });
  const formed = of(events, "box_formed")[0]!.data, decided = of(events, "box_decided")[0]!.data;
  assert.equal(formed.vwapTodayDegraded, true, "the box formed while today's bars could not be read");
  assert.equal(decided.vwapTodayDegraded, false, "by the decision the bars were back");
  assert.ok(of(events, "data_restored").some(e => e.data.source === "bars"));
  assert.equal(decided.decision.close, 160.71);
});
