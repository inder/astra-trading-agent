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
const reference = () => shared ??= replay({ SOXL: referenceBars(), LAGG: referenceBars() }, { SOXL: runawayDailies(), LAGG: laggardDailies() });

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
  const r = await reference(), claims = checkBoxes(r, file({ SOXL: referenceBars(), LAGG: referenceBars() }), { SOXL: runawayDailies(), LAGG: laggardDailies() }, DAY, ["SOXL", "LAGG"]);
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
test("a candle seen through too few distinct trades has no known close (ADR 0002), however steady the price", async () => {
  const r = await replay({ SOXL: referenceBars() }, { SOXL: runawayDailies() }, { pollMs: 20000, maxQuoteAgeMs: 20000, maxObservationGapMs: 60000, minCandleTrades: 10 });   // six trades a candle
  assert.equal(types(r, "box_formed").length, 0);
  assert.ok(types(r, "candle_unobserved", "SOXL").length > 0 && types(r, "candle_unobserved").every(e => e.data.reason === "sparse" || e.data.reason === "not_observed"));
  const loose = await replay({ SOXL: referenceBars() }, { SOXL: runawayDailies() }, { pollMs: 20000, maxQuoteAgeMs: 20000, maxObservationGapMs: 60000, minCandleTrades: 1 });
  assert.ok(types(loose, "box_formed").length >= 1, "the same polling with the count relaxed sees the box");
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
