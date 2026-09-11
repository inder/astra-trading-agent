import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TradingAgentService } from "../src/agent-service.ts";
import { createAgentMcpServer } from "../src/agent-mcp.ts";
import { OrbPaperRuntime, sessionTimes } from "../src/orb-paper-runtime.ts";
import { openingRangeConfig } from "../src/orb-config.ts";
import type { AgentStrategy } from "../src/agent-strategies.ts";
import { StepError } from "../src/paper-runtime.ts";
import { EntrySkip } from "../src/orb-options.ts";
import type { PaperMarket } from "../src/paper-market.ts";
import { date, open, close, id, setup, fixture, entered } from "./paper-fixture.ts";

test("session calendar handles DST, holidays and early closes", () => {
  assert.equal(new Date(open).toISOString(), "2026-09-08T13:30:00.000Z");
  assert.equal(new Date(sessionTimes("2026-01-06").open).toISOString(), "2026-01-06T14:30:00.000Z");
  assert.equal(new Date(sessionTimes("2026-11-27").close).toISOString(), "2026-11-27T18:00:00.000Z");
  assert.throws(() => sessionTimes("2026-12-25")); assert.throws(() => sessionTimes("2028-01-05"));
  assert.equal(new Date(sessionTimes("2027-01-05").open).toISOString(), "2027-01-05T14:30:00.000Z");
  assert.equal(new Date(sessionTimes("2027-11-26").close).toISOString(), "2027-11-26T18:00:00.000Z");
  assert.throws(() => sessionTimes("2027-11-25")); assert.throws(() => sessionTimes("2027-12-24"));
});
test("paper configuration is disconnected, immutable and retries are idempotent", async t => {
  const f = fixture(t), disconnected = new TradingAgentService(f.directory);
  assert.equal(disconnected.paper.configure(setup).status, "configured");
  assert.equal(disconnected.paper.configure(setup).revision, 0);
  assert.throws(() => disconnected.paper.configure({ ...setup, symbols: ["OTHER"] }), /different/);
  await assert.rejects(disconnected.paper.start(setup.runId), /Authorize/);
  assert.equal(disconnected.paper.list()[0]?.attached, false);
});
test("another paper strategy plugs into the same controller without transport-specific code", async t => {
  const f = fixture(t);
  const plugin: AgentStrategy = { id: "test-only-plugin", version: "1", name: "Synthetic test strategy", description: "Test only",
    capabilities: ["continuous_paper"], preview: value => value, runSample: () => ({ events: [], summary: {} }),
    paperFactory: () => {
      let complete = false;
      return { async step() { complete = true; return [{ type: "plugin_completed", data: { synthetic: true } }]; },
        async control() { throw new Error("No positions"); }, checkpoint: () => ({ complete }),
        view: () => ({ positions: [], committedCents: 0, realizedPnlCents: 0, unrealizedPnlCents: 0, lastQuoteAt: null, complete, detail: {} }) };
    } };
  const service = new TradingAgentService(f.directory, [plugin], undefined, f.options);
  service.paper.configure({ ...setup, strategyId: plugin.id }); await service.paper.start(setup.runId);
  await service.paper.tick(setup.runId);
  assert.equal(service.paper.status(setup.runId).status, "completed");
  assert.equal(service.paper.status(setup.runId).events[0]?.type, "plugin_completed");
  await service.close();
});
test("full paper lifecycle enforces two names, budgets, option targets, breakeven and the stop", async t => {
  const f = fixture(t); await entered(f);
  f.advance(); f.prices.DEMOB = 106; f.prices.DEMOC = 106;
  await f.service.paper.tick(setup.runId);
  let status = f.service.paper.status(setup.runId);
  assert.equal(status.view.positions.length, 2); assert.equal(status.view.committedCents, 320800);
  assert.deepEqual(status.view.positions.map(p => [p.stage, p.backstop, p.stop]), [["initial", 2, 99.9], ["initial", 2, 99.9]]);
  f.advance(); f.prices.DEMOB = 99; f.setBid(3);                 // DEMOB trades through its opening-range stop
  await f.service.paper.tick(setup.runId);
  f.advance(); f.prices.DEMOA = 108; f.setBid(8);                // DEMOA's option doubles: half its contracts sell
  await f.service.paper.tick(setup.runId);
  status = f.service.paper.status(setup.runId);
  assert.equal(status.view.positions.length, 1); assert.equal(status.view.positions[0]?.quantity, 2);
  assert.equal(status.view.positions[0]?.stage, "breakeven"); assert.equal(status.view.positions[0]?.stop, 106);
  assert.equal(status.view.realizedPnlCents, 40000);             // DEMOB 4 × ($3 − $4) + DEMOA 2 × ($8 − $4), fees excluded
  assert.equal(status.view.unrealizedPnlCents, 80000);
  assert.equal(status.view.committedCents, 320800);              // sales never release entry budget
  f.advance(); f.prices.DEMOA = 106; await f.service.paper.tick(setup.runId);   // back to the entry price
  status = f.service.paper.status(setup.runId);
  assert.equal(status.view.positions.length, 0); assert.equal(status.view.realizedPnlCents, 120000);
  assert.equal(f.service.paper.daily(date).realizedPnlCents, 120000);
  const events = f.service.paper.events(setup.runId, -1, 100).flatMap(p => p.events);
  assert.deepEqual(events.filter(e => e.type === "paper_entry").map(e => (e.data as any).backstopPrice), [2, 2]);
  assert.deepEqual(events.filter(e => e.type === "paper_sale").map(e => { const d = e.data as any; return [d.symbol, d.reason, d.quantity, d.targets ?? null]; }),
    [["DEMOB", "protective_stop", 4, null], ["DEMOA", "profit_target", 2, [2]], ["DEMOA", "breakeven_stop", 2, null]]);
  assert.equal(status.ordersSubmitted, 0);
});
test("the simulated Robinhood backstop sells everything once the bid halves, with no stock move needed", async t => {
  const f = fixture(t); await entered(f);
  f.advance(); f.setBid(2.01); await f.service.paper.tick(setup.runId);
  assert.equal(f.service.paper.status(setup.runId).view.positions[0]?.quantity, 4);
  f.advance(); f.setBid(2); await f.service.paper.tick(setup.runId);
  const s = f.service.paper.status(setup.runId);
  assert.equal(s.view.positions.length, 0); assert.equal(s.view.realizedPnlCents, -80000);   // 4 × ($2 − $4)
  const sale = s.events.find(e => e.type === "paper_sale")!.data as any;
  assert.equal(sale.reason, "broker_backstop"); assert.equal(sale.triggeredAt, new Date(open + 123000).toISOString(), "the bid that triggered it");
});
test("the final-minute flatten needs only a fresh option bid, not a fresh stock quote", async t => {
  const f = fixture(t); await entered(f); f.staleStock(6000); f.setTime(close - 60000);
  await f.service.paper.tick(setup.runId);
  const s = f.service.paper.status(setup.runId);
  assert.equal(s.view.positions.length, 0);
  assert.ok(s.events.some(e => e.type === "paper_sale" && (e.data as any).reason === "session_close"));
});
test("stale option prices skip entry and cannot fabricate exit fills or current P&L", async t => {
  const f = fixture(t); await entered(f);
  f.advance(6000); f.staleOption(6000); f.prices.DEMOA = 99;
  await f.service.paper.tick(setup.runId);
  const s = f.service.paper.status(setup.runId);
  assert.equal(s.view.positions[0]?.quantity, 4); assert.equal(s.view.unrealizedPnlCents, null);
  assert.ok(s.events.some(e => e.type === "sale_deferred"));
  f.advance(); f.staleOption(0); await f.service.paper.tick(setup.runId);
  assert.equal(f.service.paper.status(setup.runId).view.positions.length, 0);
});
test("stale entry options and late first quotes fail closed", async t => {
  const f = fixture(t); f.service.paper.configure(setup); await f.service.paper.start(setup.runId);
  f.setTime(open + 120000); f.prices.DEMOA = 106; f.staleOption(6000);
  await f.service.paper.tick(setup.runId);
  assert.equal(f.service.paper.status(setup.runId).view.positions.length, 0);
  assert.ok(f.service.paper.status(setup.runId).events.some(e => e.type === "entry_skipped"));
  f.advance(6000); f.prices.DEMOB = 106; f.staleOption(0); await f.service.paper.tick(setup.runId);
  assert.equal(f.service.paper.status(setup.runId).view.positions.length, 0);
});
test("a triggered protective exit persists through a rebound and restart until a valid simulated fill", async t => {
  const f = fixture(t); await entered(f); f.advance(); f.prices.DEMOA = 99; f.staleOption(6000);
  await f.service.paper.tick(setup.runId); await f.service.paper.stop(setup.runId);
  f.advance(); f.prices.DEMOA = 107; f.staleOption(0);
  await f.service.paper.start(setup.runId, true); await f.service.paper.tick(setup.runId);
  assert.equal(f.service.paper.status(setup.runId).view.positions.length, 0);
  assert.ok(f.service.paper.status(setup.runId).events.some(e => e.type === "paper_sale" && (e.data as any).reason === "protective_stop"));
});
test("a triggered breakeven exit also persists through a rebound and restart", async t => {
  const f = fixture(t); await entered(f);
  f.advance(); f.prices.DEMOA = 108; f.setBid(8); await f.service.paper.tick(setup.runId);           // first target: breakeven
  f.advance(); f.prices.DEMOA = 105.5; f.staleOption(6000); await f.service.paper.tick(setup.runId); // below entry, no fresh bid
  assert.ok(f.service.paper.status(setup.runId).events.some(e => e.type === "sale_deferred"));
  await f.service.paper.stop(setup.runId);
  f.advance(); f.prices.DEMOA = 108; f.staleOption(0);
  await f.service.paper.start(setup.runId, true); await f.service.paper.tick(setup.runId);
  const s = f.service.paper.status(setup.runId);
  assert.equal(s.view.positions.length, 0);
  assert.ok(s.events.some(e => e.type === "paper_sale" && (e.data as any).reason === "breakeven_stop" && (e.data as any).quantity === 2));
});
test("a saved pending backstop exit resumes and retries; a saved non-exit reason is refused", async t => {
  const f = fixture(t); await entered(f); await f.service.paper.stop(setup.runId);
  const r = f.service.paper.status(setup.runId);
  const path = join(f.directory, "paper", setup.runId, String(r.revision).padStart(8, "0") + ".json");
  const saved = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...saved, checkpoint: { ...saved.checkpoint, protectiveExits: { DEMOA: "profit_target" } } }));
  f.advance(); await assert.rejects(f.service.paper.start(setup.runId, true), /Invalid paper checkpoint/);
  writeFileSync(path, JSON.stringify({ ...saved, checkpoint: { ...saved.checkpoint, protectiveExits: { DEMOA: "broker_backstop" } } }));
  await f.service.paper.start(setup.runId, true); await f.service.paper.tick(setup.runId);
  const s = f.service.paper.status(setup.runId);
  assert.equal(s.view.positions.length, 0);
  assert.ok(s.events.some(e => e.type === "paper_sale" && (e.data as any).reason === "broker_backstop" && (e.data as any).quantity === 4));
});
test("automatic scheduling advances a configured run without a connected chat client", async t => {
  const f = fixture(t), auto = new TradingAgentService(f.directory, undefined, undefined, { ...f.options, auto: true });
  auto.paper.configure(setup); await auto.paper.start(setup.runId); f.setTime(open + 120000); f.prices.DEMOA = 106;
  try {
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 4000;
      const check = () => {
        if (auto.paper.status(setup.runId).view.positions.length === 1) resolve();
        else if (Date.now() > deadline) reject(new Error("Paper timer did not advance"));
        else setTimeout(check, 25);
      }; check();
    });
    assert.equal(auto.paper.status(setup.runId).view.positions[0]?.quantity, 4);
  } finally { await auto.close(); }
});
test("paper runtime journals the rule that ends watching and never enters after the opening low fails", async t => {
  const f = fixture(t, ["DEMOA", "DEMOB"]); // fixture range is 100–105
  const runtime = new OrbPaperRuntime(openingRangeConfig({ date, symbols: ["DEMOA", "DEMOB"], includePremarketLeadMinutes: 0, entryWindowMinutes: 30 }), f.market, f.options.clock);
  f.setTime(open + 120000); f.prices.DEMOA = 99.5; f.prices.DEMOB = 104; await runtime.step();
  const journal: any[] = [];
  for (let s = 1; s <= 5; s++) { f.advance(); f.prices.DEMOA = 106 + s; journal.push(...await runtime.step()); }
  assert.ok(!journal.some(e => e.type === "paper_entry"), "a later rally does not erase the opening failure");
  const view = runtime.view().detail as any;
  assert.equal(view.symbols.DEMOA.endReason, "opening_low_failed");
  f.setTime(open + 30 * 60000); const closing = await runtime.step();
  assert.deepEqual(closing.filter(e => e.type === "setup_disqualified").map(e => e.data), [{ symbol: "DEMOB", reason: "entry_window_closed" }]);
});
test("the opening-low failure is written to the journal with its reason", async t => {
  const f = fixture(t, ["DEMOA"]);
  const runtime = new OrbPaperRuntime(openingRangeConfig({ date, symbols: ["DEMOA"], includePremarketLeadMinutes: 0 }), f.market, f.options.clock);
  f.setTime(open + 120000); f.prices.DEMOA = 104; await runtime.step();
  f.advance(); f.prices.DEMOA = 99.5;
  const events = await runtime.step();
  assert.deepEqual(events.filter(e => e.type === "setup_disqualified").map(e => e.data),
    [{ symbol: "DEMOA", reason: "opening_low_failed", price: 99.5, tradeAt: new Date(open + 121000).toISOString() }]);
});
test("late bars: stocks are observed while the bars are pending; a low breach then ends the day and no entry comes from that wait", async t => {
  const f = fixture(t, ["DEMOA", "DEMOB"]);
  const runtime = new OrbPaperRuntime(openingRangeConfig({ date, symbols: ["DEMOA", "DEMOB"], includePremarketLeadMinutes: 0 }), f.market, f.options.clock);
  f.setBarsReady(false); f.setTime(open + 120000); f.prices.DEMOA = 106; f.prices.DEMOB = 106;
  const waiting = await runtime.step();                                    // both above the (unknown) high: nothing can enter yet
  assert.deepEqual(waiting.filter(e => ["opening_range", "paper_entry", "setup_disqualified"].includes(e.type)), []);
  f.advance(); f.prices.DEMOB = 99.5; await runtime.step();                // DEMOB trades beneath the low before the bars arrive
  f.advance(); f.prices.DEMOB = 106; f.setBarsReady(true);
  const arrived = await runtime.step();
  assert.deepEqual(arrived.filter(e => e.type === "setup_disqualified").map(e => e.data), [{ symbol: "DEMOB", reason: "opening_low_failed", lowSeen: 99.5 }]);
  assert.deepEqual(arrived.filter(e => e.type === "paper_entry").map(e => (e.data as any).symbol), ["DEMOA"], "DEMOA enters on the first live quote after the range");
  assert.ok(arrived.findIndex(e => e.type === "opening_range") < arrived.findIndex(e => e.type === "paper_entry"));
});
test("bars that never publish skip the stock only after the range deadline, with one data_gap per outage", async t => {
  const f = fixture(t, ["DEMOA", "DEMOB"]);
  const runtime = new OrbPaperRuntime(openingRangeConfig({ date, symbols: ["DEMOA", "DEMOB"], includePremarketLeadMinutes: 0 }), f.market, f.options.clock);
  f.outage("bars"); f.setTime(open + 120000);
  const journal: any[] = [];
  for (let s = 0; s <= 60; s++) { if (s === 30) { f.restore(); f.setBarsReady(false); } journal.push(...await runtime.step()); f.advance(); }
  assert.deepEqual(journal.filter(e => e.type === "setup_disqualified"), [], "still waiting at exactly the deadline");
  assert.deepEqual(journal.filter(e => e.type === "data_gap").map(e => e.data.source), ["bars"]);
  assert.deepEqual(journal.filter(e => e.type === "data_restored").map(e => e.data), [{ source: "bars", outageMs: 30000 }]);
  const late = await runtime.step();
  assert.deepEqual(late.filter(e => e.type === "setup_disqualified").map(e => e.data),
    [{ symbol: "DEMOA", reason: "range_unavailable" }, { symbol: "DEMOB", reason: "range_unavailable" }]);
});
test("a stock first seen after the opening window cannot use its range, whether or not the range had arrived", async t => {
  const f = fixture(t, ["DEMOA", "DEMOB"]);
  const runtime = new OrbPaperRuntime(openingRangeConfig({ date, symbols: ["DEMOA", "DEMOB"], includePremarketLeadMinutes: 0 }), f.market, f.options.clock);
  f.setBarsReady(false, "DEMOB"); f.staleStock(6000); f.setTime(open + 120000);
  const journal: any[] = [];
  for (let s = 0; s <= 6; s++) { journal.push(...await runtime.step()); f.advance(); }   // quotes stay 6 s old: nothing observed
  f.staleStock(0); journal.push(...await runtime.step());                                  // first fresh quotes at open + 127 s
  assert.deepEqual(journal.filter(e => e.type === "setup_disqualified").map(e => [e.data.symbol, e.data.reason]),
    [["DEMOA", "late_first_quote"], ["DEMOB", "late_first_quote"]]);
  f.setBarsReady(true); f.advance(); f.prices.DEMOA = 106; f.prices.DEMOB = 106;
  const after = await runtime.step();
  assert.deepEqual(after.filter(e => ["opening_range", "paper_entry"].includes(e.type)), [], "neither can enter or take a range later");
});
test("a run resumed while a stock's range was pending manages positions only: that stock is done for the day", async t => {
  const f = fixture(t, ["DEMOA", "DEMOB"]);
  f.service.paper.configure({ ...setup, symbols: ["DEMOA", "DEMOB"] }); await f.service.paper.start(setup.runId);
  f.setBarsReady(false, "DEMOB"); f.setTime(open + 120000); await f.service.paper.tick(setup.runId);
  f.advance(); f.prices.DEMOA = 106; await f.service.paper.tick(setup.runId);
  assert.equal(f.service.paper.status(setup.runId).view.positions.length, 1);
  await f.service.paper.stop(setup.runId); f.advance(); f.setBarsReady(true);
  await f.service.paper.start(setup.runId, true); await f.service.paper.tick(setup.runId);
  f.advance(); f.prices.DEMOB = 106; await f.service.paper.tick(setup.runId);
  const resumed = f.service.paper.events(setup.runId, -1, 100).flatMap(p => p.events);
  assert.ok(resumed.some(e => e.type === "setup_disqualified" && (e.data as any).symbol === "DEMOB" && (e.data as any).reason === "resumed_management_only"));
  assert.equal(resumed.filter(e => e.type === "opening_range" && (e.data as any).symbol === "DEMOB").length, 0);
  assert.deepEqual(f.service.paper.status(setup.runId).view.positions.map(p => p.symbol), ["DEMOA"]);
});
test("with premarket minutes the range still ends at 9:32, and a trade beneath its low while bars are pending ends the day", async t => {
  const f = fixture(t, ["DEMOA", "DEMOB"]);
  const runtime = new OrbPaperRuntime(openingRangeConfig({ date, symbols: ["DEMOA", "DEMOB"], includePremarketLeadMinutes: 2 }), f.market, f.options.clock);
  f.setBarsReady(false, "DEMOB"); f.setTime(open + 120000); f.prices.DEMOB = 99.5;
  const first = await runtime.step();
  assert.deepEqual(first.filter(e => e.type === "opening_range").map(e => e.data),
    [{ symbol: "DEMOA", range: { high: 105, low: 100, startMs: open - 120000, endMs: open + 120000 } }]);
  f.advance(); f.prices.DEMOB = 104; f.setBarsReady(true);
  const second = await runtime.step();
  assert.deepEqual(second.filter(e => e.type === "setup_disqualified").map(e => e.data), [{ symbol: "DEMOB", reason: "opening_low_failed", lowSeen: 99.5 }]);
});
test("a gap while a range is pending ends that stock's day; the range arriving later does not revive it", async t => {
  const f = fixture(t, ["DEMOA", "DEMOB"]);
  const runtime = new OrbPaperRuntime(openingRangeConfig({ date, symbols: ["DEMOA", "DEMOB"], includePremarketLeadMinutes: 0 }), f.market, f.options.clock);
  f.setBarsReady(false); f.setTime(open + 120000); await runtime.step();
  f.outage("quotes"); for (let s = 0; s < 6; s++) { f.advance(); await runtime.step(); }
  f.restore(); f.advance();
  const back = await runtime.step();
  assert.deepEqual(back.filter(e => e.type === "setup_disqualified").map(e => [(e.data as any).symbol, (e.data as any).reason]),
    [["DEMOA", "observation_gap"], ["DEMOB", "observation_gap"]]);
  f.setBarsReady(true); f.advance(); f.prices.DEMOA = 106;
  const later = await runtime.step();
  assert.deepEqual(later.filter(e => ["opening_range", "paper_entry"].includes(e.type)), []);
});
test("an outage that stops mattering closes in the journal: bars once no range is pending", async t => {
  const f = fixture(t, ["DEMOA"]);
  const runtime = new OrbPaperRuntime(openingRangeConfig({ date, symbols: ["DEMOA"], includePremarketLeadMinutes: 0, rangeDeadlineMs: 2000 }), f.market, f.options.clock);
  f.outage("bars"); f.setTime(open + 120000);
  const journal: any[] = [];
  for (let s = 0; s < 5; s++) { journal.push(...await runtime.step()); f.advance(); }
  assert.deepEqual(journal.filter(e => e.type.startsWith("data_") || e.type === "setup_disqualified").map(e => [e.type, e.data.source ?? e.data.reason]),
    [["data_gap", "bars"], ["setup_disqualified", "range_unavailable"], ["data_gap_ended", "bars"]]);
  assert.equal(runtime.view().dataGapSince, null);
});
test("the journal records the run's own freshness verdict, not the market layer's fixed 5 s flag", async t => {
  const f = fixture(t, ["DEMOA"]);
  const runtime = new OrbPaperRuntime(openingRangeConfig({ date, symbols: ["DEMOA"], includePremarketLeadMinutes: 0, maxQuoteAgeMs: 10000 }), f.market, f.options.clock);
  f.setTime(open + 120000); f.staleStock(7000);
  const events = await runtime.step();
  assert.equal((events.find(e => e.type === "heartbeat")!.data as any).latest.DEMOA.fresh, true, "7 s old is fresh under a 10 s setting");
  assert.notEqual((runtime.view().detail as any).symbols.DEMOA.lastObservationMs, null);
});
test("catalogs load before 9:32, one per tick, so an entry quotes one batch and loads no catalog", async t => {
  const f = fixture(t);
  const runtime = new OrbPaperRuntime(openingRangeConfig({ date, symbols: setup.symbols, includePremarketLeadMinutes: 0 }), f.market, f.options.clock);
  for (let at = open + 60000; at < open + 120000; at += 1000) { f.setTime(at); await runtime.step(); }
  assert.equal(f.reads.contracts, 3);
  f.setTime(open + 120000); await runtime.step();
  f.advance(); f.prices.DEMOA = 106;
  const entry = await runtime.step();
  assert.equal((entry.find(e => e.type === "option_selection")!.data as any).batches, 1);
  assert.equal(f.reads.contracts, 3, "no catalog read at the entry");
  // With no time left before 9:32 beyond one poll nothing is prefetched; the catalog then loads at the entry instead.
  const late = fixture(t, ["DEMOA"]);
  const lateRun = new OrbPaperRuntime(openingRangeConfig({ date, symbols: ["DEMOA"], includePremarketLeadMinutes: 0 }), late.market, late.options.clock);
  late.setTime(open + 119000); await lateRun.step(); assert.equal(late.reads.contracts, 0);
  late.setTime(open + 120000); await lateRun.step(); late.advance(); late.prices.DEMOA = 106;
  late.slowCatalog(6000); const lazy = await lateRun.step();
  assert.deepEqual([late.reads.contracts, lateRun.view().positions.length], [1, 1]);
  // The slow catalog load comes first, so the stock quote the entry uses is fetched after it, not 6 s before.
  assert.equal((lazy.find(e => e.type === "option_selection")!.data as any).stock.retrievedAt, new Date(open + 127000).toISOString());
});
test("a slow catalog prefetch never delays the first observation after 9:32", async t => {
  const f = fixture(t);
  const runtime = new OrbPaperRuntime(openingRangeConfig({ date, symbols: setup.symbols, includePremarketLeadMinutes: 0 }), f.market, f.options.clock);
  f.slowCatalog(6000); f.setTime(open + 100000);
  const journal: any[] = [];
  while (f.options.clock() < open + 120000) { journal.push(...await runtime.step()); f.advance(); }
  assert.equal(f.reads.contracts, 2, "the third load would have run past the fence");
  f.slowCatalog(0); f.setTime(open + 120000); journal.push(...await runtime.step());
  assert.deepEqual(journal.filter(e => e.type === "setup_disqualified"), [], "every stock observed in time");
});
test("a first catalog load that would run past 9:32 is abandoned at the deadline, and its late answer is still kept", async t => {
  const f = fixture(t, ["DEMOA"]); const contracts = f.market.contracts;
  f.market.contracts = async (symbol, day) => { await new Promise(r => setTimeout(r, 300)); return contracts(symbol, day); };   // 300 ms of real latency
  const runtime = new OrbPaperRuntime(openingRangeConfig({ date, symbols: ["DEMOA"], includePremarketLeadMinutes: 0 }), f.market, f.options.clock);
  f.setTime(open + 119000 - 50);                                     // 50 ms left before the range end minus one poll
  const started = Date.now(); await runtime.step();
  assert.ok(Date.now() - started < 250, `the step waited ${Date.now() - started} ms instead of giving up at the deadline`);
  await new Promise(r => setTimeout(r, 350));                        // the abandoned load finishes afterwards
  f.setTime(open + 120000); const first = await runtime.step();
  assert.deepEqual(first.filter(e => e.type === "setup_disqualified"), [], "the first observation after 9:32 was on time");
  f.advance(); f.prices.DEMOA = 106; await runtime.step();
  assert.deepEqual([f.reads.contracts, runtime.view().positions.length], [1, 1], "the late catalog was kept: no second load at the entry");
});
test("prefetch failures retry and close at 9:32; a no-expiry catalog is a decision, journaled once and reused at the entry", async t => {
  const f = fixture(t, ["DEMOA", "DEMOB"]); const contracts = f.market.contracts; let failing = true, demob = 0;
  f.market.contracts = async (symbol, day) => {
    if (symbol === "DEMOB") { demob++; throw new EntrySkip("no_qualifying_expiry"); }
    if (failing) throw new Error("test-only catalog outage");
    return contracts(symbol, day);
  };
  const runtime = new OrbPaperRuntime(openingRangeConfig({ date, symbols: ["DEMOA", "DEMOB"], includePremarketLeadMinutes: 0 }), f.market, f.options.clock);
  const journal: any[] = [];
  for (let at = open + 60000; at < open + 120000; at += 1000) { f.setTime(at); journal.push(...await runtime.step()); }
  assert.deepEqual(journal.filter(e => e.type === "no_tradable_calls").map(e => e.data), [{ symbol: "DEMOB", reason: "no_qualifying_expiry" }]);
  assert.deepEqual(journal.filter(e => e.type === "data_gap").map(e => e.data.source), ["catalog"]);
  failing = false; f.setTime(open + 120000); journal.push(...await runtime.step());
  assert.deepEqual(journal.filter(e => e.type === "data_gap_ended").map(e => [e.data.source, e.data.reason]), [["catalog", "prefetch_window_closed"]]);
  f.advance(); f.prices.DEMOA = 106; f.prices.DEMOB = 106; journal.push(...await runtime.step());
  assert.deepEqual(journal.filter(e => e.type === "entry_skipped").map(e => e.data), [{ symbol: "DEMOB", reason: "no_qualifying_expiry" }]);
  assert.equal(demob, 1, "the decision is reused, not reloaded");
  assert.equal(runtime.view().positions[0]?.symbol, "DEMOA", "DEMOA's catalog loaded at its entry");
});
test("an entry quotes the nearest strikes first and widens only while nothing qualifies", async t => {
  const f = fixture(t, ["DEMOA"]), seen: number[] = [];
  const strike = (n: number) => 100 + n, contractFor = (n: number) => ({ id: id(n + 1), symbol: "DEMOA", expiration: "2026-09-11", strike: strike(n), multiplier: 100 as const,
    tickBelow: .01, tickAbove: .05, tickCutoff: 3, selloutAt: "2026-09-11T19:30:00Z" });
  const catalog = Array.from({ length: 31 }, (_, n) => contractFor(n));   // strikes 100 through 130
  f.market.contracts = async () => ({ expiration: "2026-09-11", contracts: catalog });
  // Strikes up to 121 cost $6 (4 contracts would be $2,404, over the cap); from 122 they cost $4 and 4 fit.
  f.market.optionQuotes = async ids => { seen.push(ids.length); const now = new Date(f.options.clock()).toISOString();
    return ids.map(qid => { const k = catalog.find(x => x.id === qid)!; const ask = k.strike <= 121 ? 6 : 4;
      return { id: qid, bid: ask - .1, ask, askSize: 20, updatedAt: now, retrievedAt: now }; }); };
  await entered(f, ["DEMOA"]);
  const selection = f.service.paper.events(setup.runId, -1, 100).flatMap(p => p.events).find(e => e.type === "option_selection")!.data as any;
  assert.equal(selection.selected.contract.strike, 122); assert.equal(selection.batches, 2);
  assert.deepEqual(seen.slice(0, 2), [20, 11], "the nearest 20 by distance from $106, then the rest");
  // With one batch allowed, the entry is skipped for that reason, not as if no strike could ever fit.
  const capped = fixture(t, ["DEMOA"]);
  capped.market.contracts = f.market.contracts; capped.market.optionQuotes = f.market.optionQuotes;
  capped.service.paper.configure({ ...setup, symbols: ["DEMOA"], maxEntryQuoteBatches: 1 }); await capped.service.paper.start(setup.runId);
  capped.setTime(open + 120000); await capped.service.paper.tick(setup.runId);
  capped.advance(); capped.prices.DEMOA = 106; await capped.service.paper.tick(setup.runId);
  assert.deepEqual(capped.service.paper.status(setup.runId).events.find(e => e.type === "entry_skipped")?.data,
    { symbol: "DEMOA", reason: "no_qualifying_call_within_quote_batches", quotedContracts: 20, batches: 1 });
});
test("a stop that cannot fill during an option outage is journaled once, and each tick asks for option prices once", async t => {
  const f = fixture(t, ["DEMOA"]); await entered(f, ["DEMOA"]);
  const optionQuotes = f.market.optionQuotes; let calls = 0;
  f.market.optionQuotes = async ids => { calls++; return optionQuotes(ids); };
  f.outage("options"); f.prices.DEMOA = 99;
  const before = f.service.paper.events(setup.runId, -1, 100).length;
  for (let s = 0; s < 30; s++) { f.advance(); await f.service.paper.tick(setup.runId); }
  const pages = f.service.paper.events(setup.runId, -1, 100), journal = pages.flatMap(p => p.events);
  assert.deepEqual(journal.filter(e => ["exit_triggered", "sale_deferred", "data_gap"].includes(e.type)).map(e => e.type), ["exit_triggered", "sale_deferred", "data_gap"]);
  assert.equal(calls, 30, "one option batch per tick, no second request per stop");
  assert.ok(pages.length - before <= 3, `${pages.length - before} revisions over 30 ticks`);
  f.restore(); f.advance(); await f.service.paper.tick(setup.runId);
  assert.ok(f.service.paper.status(setup.runId).events.some(e => e.type === "paper_sale" && (e.data as any).reason === "protective_stop" && (e.data as any).quantity === 4));
});
test("a stop firing while a different exit is already pending is journaled once, and the pending exit still executes", async t => {
  const f = fixture(t, ["DEMOA"]); await entered(f, ["DEMOA"]); await f.service.paper.stop(setup.runId);
  const r = f.service.paper.status(setup.runId), path = join(f.directory, "paper", setup.runId, String(r.revision).padStart(8, "0") + ".json");
  const saved = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...saved, checkpoint: { ...saved.checkpoint, protectiveExits: { DEMOA: "broker_backstop" } } }));
  f.staleOption(6000); f.prices.DEMOA = 99; f.advance(); await f.service.paper.start(setup.runId, true);
  for (let s = 0; s < 5; s++) { f.advance(); await f.service.paper.tick(setup.runId); }
  const triggers = f.service.paper.events(setup.runId, -1, 100).flatMap(p => p.events).filter(e => e.type === "exit_triggered");
  assert.deepEqual(triggers.map(e => [(e.data as any).exit, (e.data as any).alreadyPending]), [["protective_stop", "broker_backstop"]]);
  f.staleOption(0); f.advance(); await f.service.paper.tick(setup.runId);
  assert.ok(f.service.paper.status(setup.runId).events.some(e => e.type === "paper_sale" && (e.data as any).reason === "broker_backstop"));
});
test("a failed read during an entry counts in the heartbeat like any other", async t => {
  const f = fixture(t, ["DEMOA"]); const quotes = f.market.quotes; let reads = 0;
  f.market.quotes = async s => { reads++; if (reads === 3) throw new Error("test-only 503"); return quotes(s); };
  const runtime = new OrbPaperRuntime(openingRangeConfig({ date, symbols: ["DEMOA"], includePremarketLeadMinutes: 0, heartbeatMs: 5000 }), f.market, f.options.clock);
  f.setTime(open + 120000); await runtime.step();
  f.advance(); f.prices.DEMOA = 106;
  const entry = await runtime.step();
  assert.deepEqual(entry.filter(e => e.type === "entry_skipped").map(e => [(e.data as any).reason, (e.data as any).detail]), [["data_unavailable", "test-only 503"]]);
  f.advance(5000); const later = await runtime.step();
  assert.equal((later.find(e => e.type === "heartbeat")!.data as any).readFailures.quotes, 1);
});
test("a breakout with every position slot taken, or one that reverses before the entry quote, is a skip with its evidence", async t => {
  const f = fixture(t); await entered(f);
  f.advance(); f.prices.DEMOB = 106; await f.service.paper.tick(setup.runId);
  f.advance(); f.prices.DEMOC = 106.5; await f.service.paper.tick(setup.runId);
  assert.deepEqual(f.service.paper.status(setup.runId).events.find(e => e.type === "entry_skipped")?.data,
    { symbol: "DEMOC", reason: "maximum_positions_reached", price: 106.5, tradeAt: new Date(open + 123000).toISOString() });
  const r = fixture(t, ["DEMOA"]); const quotes = r.market.quotes; let reads = 0;
  r.market.quotes = async s => { reads++; const got = await quotes(s); return reads === 3 ? got.map(q => ({ ...q, price: 104.5 })) : got; };
  r.service.paper.configure({ ...setup, symbols: ["DEMOA"] }); await r.service.paper.start(setup.runId);
  r.setTime(open + 120000); await r.service.paper.tick(setup.runId);
  r.advance(); r.prices.DEMOA = 106; await r.service.paper.tick(setup.runId);   // observed above the high; the entry's own quote is back inside
  assert.deepEqual(r.service.paper.status(setup.runId).events.find(e => e.type === "entry_skipped")?.data,
    { symbol: "DEMOA", reason: "breakout_reversed", price: 104.5, tradeAt: new Date(open + 121000).toISOString() });
});
test("a full session journals changes and a heartbeat a minute: under 1,000 revisions through a flapping provider and an option outage", async t => {
  const f = fixture(t);
  const runtime = new OrbPaperRuntime(openingRangeConfig({ date, symbols: setup.symbols, includePremarketLeadMinutes: 0, entryWindowMinutes: 390 }), f.market, f.options.clock);
  const quotes = f.market.quotes; let flapping = false, tick = 0, revisions = 0; const heartbeats: any[] = [], types = new Set<string>();
  f.market.quotes = async s => { if (flapping && tick % 2) throw new Error("test-only 429"); return quotes(s); };
  for (f.setTime(open + 120000); f.options.clock() <= close; f.advance(), tick++) {
    const at = f.options.clock() - open;
    if (at === 30 * 60000) f.prices.DEMOA = 106;                               // 10:00 DEMOA breaks out
    flapping = at >= 60 * 60000 && at < 90 * 60000;                           // 10:30-11:00 every other quote read fails
    if (at === 120 * 60000) { f.outage("options"); f.prices.DEMOA = 99; }      // 11:30 its stop fires into an option outage
    if (at === 150 * 60000) f.restore();                                       // 12:00 prices return and the stop fills
    const events = await runtime.step();
    if (events.length) revisions++;
    for (const e of events) { types.add(e.type); if (e.type === "heartbeat") heartbeats.push(e.data); }
  }
  assert.ok(revisions < 1000, `${revisions} revisions`);
  assert.ok(heartbeats.length >= 385 && heartbeats.length <= 392, `${heartbeats.length} heartbeats`);
  for (const t of ["paper_entry", "exit_triggered", "sale_deferred", "paper_sale", "session_ended"]) assert.ok(types.has(t), t);
  assert.ok(!types.has("quote") && !types.has("option_mark"), "no per-tick events");
  const flap = heartbeats.find(h => h.readFailures.quotes);
  assert.ok(flap.readFailures.quotes >= 25 && flap.observed.DEMOB.observations >= 25, "the heartbeat counts failures and observations");
  assert.deepEqual(Object.keys(heartbeats[0].latest), setup.symbols);
});
test("the MCP server and its clients report the package version", async t => {
  const f = fixture(t), server = createAgentMcpServer(f.service), client = new Client({ name: "version", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  assert.equal(client.getServerVersion()?.version, JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
});
test("a quote stamped after its own fetch (clock skew) is not an observation and cannot throw", async t => {
  const f = fixture(t, ["DEMOA"]);
  const runtime = new OrbPaperRuntime(openingRangeConfig({ date, symbols: ["DEMOA"], includePremarketLeadMinutes: 0 }), f.market, f.options.clock);
  f.setTime(open + 120000); f.staleStock(-1); f.prices.DEMOA = 106;
  await runtime.step();
  assert.equal((runtime.view().detail as any).symbols.DEMOA.lastObservationMs, null);
  assert.equal(runtime.view().positions.length, 0);
});
test("a slow entry does not cost the other stock its observation that tick, but the next poll's gap is honest", async t => {
  const f = fixture(t, ["DEMOA", "DEMOB"]);
  const runtime = new OrbPaperRuntime(openingRangeConfig({ date, symbols: ["DEMOA", "DEMOB"], includePremarketLeadMinutes: 0 }), f.market, f.options.clock);
  f.setTime(open + 120000); await runtime.step();
  f.slowCatalog(6000); f.advance(); f.prices.DEMOA = 106;
  const first = await runtime.step();
  assert.deepEqual(first.filter(e => e.type === "paper_entry").map(e => (e.data as any).symbol), ["DEMOA"]);
  assert.equal((runtime.view().detail as any).symbols.DEMOB.status, "watching", "observed as of the shared fetch, before the slow entry");
  f.slowCatalog(0); f.advance();
  const second = await runtime.step();
  assert.deepEqual(second.filter(e => e.type === "setup_disqualified").map(e => [(e.data as any).symbol, (e.data as any).reason]), [["DEMOB", "observation_gap"]]);
});
test("stop persists positions; explicit restart recovery manages only prior positions", async t => {
  const f = fixture(t); await entered(f); await f.service.paper.stop(setup.runId);
  f.advance(6000);
  const second = new TradingAgentService(f.directory, undefined, undefined, f.options);
  assert.equal(second.paper.status(setup.runId).attached, false);
  assert.equal(second.paper.status(setup.runId).view.unrealizedPnlCents, null);
  await assert.rejects(second.paper.start(setup.runId), /resume/);
  await second.paper.start(setup.runId, true);
  f.prices.DEMOB = 106; await second.paper.tick(setup.runId);
  assert.deepEqual(second.paper.status(setup.runId).view.positions.map(p => p.symbol), ["DEMOA"]);
  // Symbols still watching when the run stopped are done for the day, and the journal says why.
  const reasons = second.paper.events(setup.runId, -1, 100).flatMap(p => p.events).filter(e => e.type === "setup_disqualified").map(e => e.data);
  assert.deepEqual(reasons, [{ symbol: "DEMOB", reason: "resumed_management_only" }, { symbol: "DEMOC", reason: "resumed_management_only" }]);
  f.advance(); f.prices.DEMOA = 99; await second.paper.tick(setup.runId);
  assert.equal(second.paper.status(setup.runId).view.positions.length, 0);
  await second.close();
});
test("duplicate processes and second same-date runs cannot recycle reservations", async t => {
  const f = fixture(t); await entered(f);
  const second = new TradingAgentService(f.directory, undefined, undefined, f.options);
  assert.equal(second.paper.status(setup.runId).needsResume, true);
  await assert.rejects(second.paper.start(setup.runId, true), /owns this run/);
  f.setTime(open - 1000);
  second.paper.configure({ ...setup, runId: "another" });
  await assert.rejects(second.paper.start("another"), /already has a run/);
});
test("one failed read is only counted; two in a row are a journaled data gap, never a halt; the gap rule still judges watched stocks", async t => {
  const f = fixture(t); await entered(f);
  const journal = () => f.service.paper.events(setup.runId, -1, 100).flatMap(p => p.events);
  f.outage("quotes"); f.advance(); await f.service.paper.tick(setup.runId);
  assert.equal(journal().filter(e => e.type === "data_gap").length, 0, "a single failed read is only counted");
  assert.equal(f.service.paper.status(setup.runId).view.dataGapSince, new Date(open + 122000).toISOString());
  f.advance(); await f.service.paper.tick(setup.runId);
  assert.deepEqual(journal().filter(e => e.type === "data_gap").map(e => [(e.data as any).source, (e.data as any).since]),
    [["quotes", new Date(open + 122000).toISOString()]]);
  f.restore(); f.advance(); await f.service.paper.tick(setup.runId);
  const s = f.service.paper.status(setup.runId);
  assert.equal(s.status, "running");
  assert.deepEqual(journal().find(e => e.type === "data_restored")?.data, { source: "quotes", outageMs: 2000 });
  assert.equal((s.view.detail as any).symbols.DEMOB.status, "watching", "three seconds between observations is within the gap");
  f.outage("quotes"); f.advance(6000); await f.service.paper.tick(setup.runId);
  f.restore(); f.advance(); await f.service.paper.tick(setup.runId);
  const gaps = journal().filter(e => e.type === "setup_disqualified");
  assert.deepEqual(gaps.map(e => [(e.data as any).symbol, (e.data as any).reason]), [["DEMOB", "observation_gap"], ["DEMOC", "observation_gap"]]);
  assert.equal((gaps[0]!.data as any).previousObservedAt, new Date(open + 124000).toISOString(), "a gap names its other end");
});
test("a sustained outage halts a run holding nothing, but not one whose option prices still manage its exits", async t => {
  const idle = fixture(t); idle.service.paper.configure(setup); await idle.service.paper.start(setup.runId);
  idle.setTime(open + 120000); await idle.service.paper.tick(setup.runId);
  idle.outage("quotes"); idle.advance(); await idle.service.paper.tick(setup.runId);
  idle.advance(60000); await idle.service.paper.tick(setup.runId);                       // out exactly 60 s: not yet
  idle.advance(1); await assert.rejects(idle.service.paper.tick(setup.runId), /halted/);
  const halted = idle.service.paper.status(setup.runId);
  assert.equal(halted.status, "error"); assert.match((halted.events.at(-1)!.data as any).detail, /Market data unavailable for more than 60 s/);
  // Holding a position with option prices still arriving: the equity outage is journaled and the bid-driven exits work.
  const held = fixture(t); await entered(held);
  held.outage("quotes"); held.advance(); await held.service.paper.tick(setup.runId);
  held.advance(61000); await held.service.paper.tick(setup.runId);
  assert.equal(held.service.paper.status(setup.runId).status, "running");
  // The bid halves: the backstop sells, and with nothing left held the outage halts in the same step, keeping the sale.
  held.setBid(2); held.advance(); await assert.rejects(held.service.paper.tick(setup.runId), /halted/);
  assert.deepEqual(held.service.paper.status(setup.runId).events.map(e => e.type === "paper_sale" ? `sale:${(e.data as any).reason}` : e.type),
    ["sale:broker_backstop", "run_halted"]);
  assert.equal(held.service.paper.status(setup.runId).view.realizedPnlCents, -80000);
  // Holding a position with option prices out too: halt, keeping the committed position for recovery or settlement.
  const dark = fixture(t); await entered(dark);
  dark.outage(); dark.advance(); await dark.service.paper.tick(setup.runId);
  dark.advance(60001); await assert.rejects(dark.service.paper.tick(setup.runId), /halted/);
  assert.equal(dark.service.paper.status(setup.runId).view.positions[0]?.quantity, 4);
  assert.equal(dark.service.paper.status(setup.runId).attached, false);
});
test("an option-price outage alone never halts: exits wait for a fresh bid and unsold contracts are written off", async t => {
  const f = fixture(t); await entered(f);
  f.outage("options"); f.advance(); await f.service.paper.tick(setup.runId);
  f.advance(61000); f.prices.DEMOA = 99; await f.service.paper.tick(setup.runId);   // the stock stop fires, but no bid can fill it
  let s = f.service.paper.status(setup.runId);
  assert.equal(s.status, "running"); assert.equal(s.view.positions[0]?.quantity, 4); assert.notEqual(s.view.dataGapSince, null);
  assert.ok(s.events.some(e => e.type === "sale_deferred"));
  f.setTime(close); await f.service.paper.tick(setup.runId);
  s = f.service.paper.status(setup.runId);
  assert.equal(s.status, "completed"); assert.equal(s.view.realizedPnlCents, -160000);
  assert.equal(f.service.paper.events(setup.runId, -1, 100).flatMap(p => p.events).filter(e => e.type === "paper_sale").length, 0, "no invented fill");
});
test("a code defect inside a read halts the run with its message instead of passing as an outage", async t => {
  const f = fixture(t); await entered(f);
  f.market.optionQuotes = async () => { throw new TypeError("test-only defect: cannot read bid of undefined"); };
  f.advance(); await assert.rejects(f.service.paper.tick(setup.runId), /halted/);
  const halted = f.service.paper.status(setup.runId);
  assert.equal(halted.status, "error"); assert.match((halted.events.at(-1)!.data as any).detail, /test-only defect/);
  assert.equal(halted.view.positions[0]?.quantity, 4);
});
test("a halted step keeps the events it produced and the runtime's own state", async t => {
  const f = fixture(t); let state = 0;
  const plugin: AgentStrategy = { id: "test-only-halting", version: "1", name: "Halting test strategy", description: "Test only",
    capabilities: ["continuous_paper"], preview: value => value, runSample: () => ({ events: [], summary: {} }),
    paperFactory: () => ({ async step() { state = 7; throw new StepError(new Error("test-only storage failure"), [{ type: "paper_entry", data: { symbol: "X" } }]); },
      async control() { throw new Error("No positions"); }, checkpoint: () => ({ state }),
      view: () => ({ positions: [], committedCents: 0, realizedPnlCents: 0, unrealizedPnlCents: 0, lastQuoteAt: null, complete: false, detail: {} }) }) };
  const service = new TradingAgentService(f.directory, [plugin], undefined, f.options);
  try {
    service.paper.configure({ ...setup, strategyId: plugin.id }); await service.paper.start(setup.runId);
    await assert.rejects(service.paper.tick(setup.runId), /halted/);
    const halted = service.paper.status(setup.runId);
    assert.equal(halted.status, "error"); assert.deepEqual(halted.checkpoint, { state: 7 });
    assert.deepEqual(halted.events.map(e => e.type), ["paper_entry", "run_halted"]);
    assert.match((halted.events[1]!.data as any).detail, /storage failure/);
  } finally { await service.close(); }
});
test("the controller's timer follows the runtime's poll interval", async t => {
  const f = fixture(t); let steps = 0;
  const plugin: AgentStrategy = { id: "test-only-fast", version: "1", name: "Fast test strategy", description: "Test only",
    capabilities: ["continuous_paper"], preview: value => value, runSample: () => ({ events: [], summary: {} }),
    paperFactory: () => ({ pollMs: 50, async step() { steps++; return []; }, async control() { throw new Error("No positions"); }, checkpoint: () => ({}),
      view: () => ({ positions: [], committedCents: 0, realizedPnlCents: 0, unrealizedPnlCents: 0, lastQuoteAt: null, complete: false, detail: {} }) }) };
  const auto = new TradingAgentService(f.directory, [plugin], undefined, { ...f.options, auto: true });
  try {
    auto.paper.configure({ ...setup, strategyId: plugin.id }); await auto.paper.start(setup.runId);
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.ok(steps >= 4, `${steps} steps in 400 ms at a 50 ms poll`);
  } finally { await auto.close(); }
});
test("a detached run's marks go stale on the run's own quote-age setting", async t => {
  const f = fixture(t); f.service.paper.configure({ ...setup, maxQuoteAgeMs: 10000 }); await f.service.paper.start(setup.runId);
  f.setTime(open + 120000); await f.service.paper.tick(setup.runId);
  f.advance(); f.prices.DEMOA = 106; await f.service.paper.tick(setup.runId);
  await f.service.paper.stop(setup.runId); f.advance(7000);
  assert.equal(f.service.paper.status(setup.runId).view.unrealizedPnlCents, -4000, "a 7 s old mark is inside a 10 s setting");
  f.advance(4000); assert.equal(f.service.paper.status(setup.runId).view.unrealizedPnlCents, null);
});
test("session-close simulation flattens at the fresh bid one minute before the close", async t => {
  const f = fixture(t); await entered(f); f.setTime(close - 60000);
  await f.service.paper.tick(setup.runId);
  assert.equal(f.service.paper.status(setup.runId).view.positions.length, 0);
  f.setTime(close); await f.service.paper.tick(setup.runId);
  const s = f.service.paper.status(setup.runId);
  assert.equal(s.status, "completed"); assert.equal(s.view.realizedPnlCents, -4000);   // 4 × ($3.90 − $4.00)
  assert.deepEqual(s.events.find(e => e.type === "session_ended")?.data, { writtenOff: 0, noAutomaticCarryOrExercise: true });
  await assert.rejects(f.service.paper.start(setup.runId, true), /expired/);
});
test("contracts that cannot be sold before the close are written off as a total loss", async t => {
  const f = fixture(t); await entered(f); f.staleOption(6000); f.setTime(close - 60000);
  await f.service.paper.tick(setup.runId);
  assert.equal(f.service.paper.status(setup.runId).view.positions.length, 1, "no fill is invented from a stale bid");
  f.setTime(close); await f.service.paper.tick(setup.runId);
  const s = f.service.paper.status(setup.runId);
  assert.equal(s.status, "completed"); assert.equal(s.view.positions.length, 0); assert.equal(s.view.realizedPnlCents, -160000);
  assert.deepEqual(s.events.filter(e => e.type === "written_off").map(e => e.data),
    [{ symbol: "DEMOA", contractId: id(1), quantity: 4, realizedPnlCents: -160000, reason: "unsold_at_session_end" }]);
  assert.equal(f.service.paper.daily(date).realizedPnlCents, -160000);
});
test("a run stopped while holding contracts settles after the close: they are written off, once", async t => {
  const f = fixture(t); await entered(f); await f.service.paper.stop(setup.runId);
  f.setTime(close + 60000);
  assert.equal(f.service.paper.list()[0]?.needsSettlement, true);
  await assert.rejects(f.service.paper.start(setup.runId), /expired/, "a fresh start after the close is still refused");
  const settled = await f.service.paper.start(setup.runId, true);
  assert.equal(settled.status, "completed"); assert.equal(settled.view.positions.length, 0); assert.equal(settled.view.realizedPnlCents, -160000);
  // Symbols still watching when the run stopped end on the entry window, not a "resumed" management claim.
  assert.deepEqual(settled.events.map(e => e.type === "setup_disqualified" ? `${(e.data as any).symbol}:${(e.data as any).reason}` : e.type),
    ["settled_after_session", "DEMOB:entry_window_closed", "DEMOC:entry_window_closed", "written_off", "session_ended"]);
  assert.equal(f.service.paper.daily(date).realizedPnlCents, -160000);
  assert.equal(f.service.paper.list()[0]?.needsSettlement, false);
  await assert.rejects(f.service.paper.start(setup.runId, true), /expired/, "settled exactly once");
});
test("settlement needs no market data or authorization: a halted run settles while every read fails", async t => {
  const f = fixture(t); await entered(f); f.outage(); f.advance(); await f.service.paper.tick(setup.runId);
  f.advance(60001); await assert.rejects(f.service.paper.tick(setup.runId), /halted/);
  f.setTime(close + 60000);
  const fail = async (): Promise<never> => { throw new Error("test-only: no market data after the close"); };
  const dead: PaperMarket = { quotes: fail, bars: fail, contracts: fail, optionQuotes: fail };
  const offline = new TradingAgentService(f.directory, undefined, undefined, { ...f.options, ready: () => false, market: dead });
  try {
    const settled = await offline.paper.start(setup.runId, true);
    assert.equal(settled.status, "completed"); assert.equal(settled.view.realizedPnlCents, -160000);
    assert.deepEqual(settled.events[0], { type: "settled_after_session", data: { previousStatus: "error" } });
  } finally { await offline.close(); }
});
test("a crashed run left running with a dead owner process settles after the close, and says settlement not resume", async t => {
  const f = fixture(t); await entered(f); await f.service.paper.stop(setup.runId);
  const r = f.service.paper.status(setup.runId), dir = join(f.directory, "paper", setup.runId);
  const path = join(dir, String(r.revision).padStart(8, "0") + ".json");
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), status: "running" }));           // what a crash leaves
  writeFileSync(join(dir, "owner.json"), JSON.stringify({ pid: spawnSync(process.execPath, ["-e", ""]).pid }));   // an exited process
  f.setTime(close + 60000);
  const listed = f.service.paper.list()[0]!;
  assert.deepEqual([listed.needsResume, listed.needsSettlement], [false, true]);
  const settled = await f.service.paper.start(setup.runId, true);
  assert.equal(settled.status, "completed"); assert.deepEqual(settled.events[0]?.data, { previousStatus: "running" });
});
test("the close-out lead is a setting: ten minutes flattens at 3:50 and refuses new entries from then", async t => {
  const f = fixture(t, ["DEMOA", "DEMOB"]);
  const config = openingRangeConfig({ date, symbols: ["DEMOA", "DEMOB"], includePremarketLeadMinutes: 0, entryWindowMinutes: 390, flattenLeadMinutes: 10,
    maxObservationGapMs: 60000 });
  const runtime = new OrbPaperRuntime(config, f.market, f.options.clock);
  f.setTime(open + 120000); await runtime.step();
  f.advance(); f.prices.DEMOA = 106; await runtime.step();
  assert.equal(runtime.view().positions.length, 1);
  // Poll through the afternoon inside the observation gap, so DEMOB is still watched when the close-out begins.
  for (let at = open + 171000; at < close - 600001; at += 50000) { f.setTime(at); await runtime.step(); }
  f.setTime(close - 600001); assert.deepEqual((await runtime.step()).filter(e => e.type === "paper_sale"), []);
  f.setTime(close - 600000); f.prices.DEMOB = 106;
  const events = await runtime.step();
  assert.deepEqual(events.filter(e => e.type === "entry_skipped").map(e => e.data), [{ symbol: "DEMOB", reason: "too_close_to_session_end" }]);
  assert.deepEqual(events.filter(e => e.type === "paper_sale").map(e => [(e.data as any).symbol, (e.data as any).reason]), [["DEMOA", "session_close"]]);
});
test("corrupt checkpoint cannot resume a fabricated reservation", async t => {
  const f = fixture(t); await entered(f); await f.service.paper.stop(setup.runId);
  const r = f.service.paper.status(setup.runId);
  const path = join(f.directory, "paper", setup.runId, String(r.revision).padStart(8, "0") + ".json");
  const value = JSON.parse(readFileSync(path, "utf8")); value.checkpoint.engine.reservedPositions = 0;
  writeFileSync(path, JSON.stringify(value));
  await assert.rejects(f.service.paper.start(setup.runId, true), /reservations/);
});

async function browserReview(url: string) {
  const get = await fetch(url); const html = await get.text();
  const csrf = html.match(/name="csrf" value="([^"]+)"/)![1]!;
  return { headers: { origin: new URL(url).origin, "content-type": "application/x-www-form-urlencoded", cookie: get.headers.get("set-cookie")!.split(";")[0]! },
    body: new URLSearchParams({ csrf, decision: "approve" }).toString() };
}
test("review requires separate browser approval, rejects forgery and duplicates, then rechecks quantity", async t => {
  const f = fixture(t); await entered(f);
  const first = await f.service.reviews.propose(setup.runId, "DEMOA", "trim", 25);
  const stale = await f.service.reviews.propose(setup.runId, "DEMOA", "close");
  assert.equal(first.command.quantity, 1); assert.equal(first.executed, false);
  const form = await browserReview(first.reviewUrl);
  assert.equal((await fetch(first.reviewUrl, { method: "POST", ...form, headers: { ...form.headers, origin: "https://untrusted.invalid" } })).status, 403);
  assert.equal((await fetch(first.reviewUrl, { method: "POST", ...form, body: "csrf=wrong&decision=approve" })).status, 403);
  assert.equal(f.service.paper.status(setup.runId).view.positions[0]?.quantity, 4);
  assert.equal((await fetch(first.reviewUrl, { method: "POST", ...form })).status, 200);
  assert.equal(f.service.reviews.status(first.reviewId).status, "executed");
  assert.equal(f.service.paper.status(setup.runId).view.positions[0]?.quantity, 3);
  assert.equal((await fetch(first.reviewUrl, { method: "POST", ...form })).status, 410);
  const staleForm = await browserReview(stale.reviewUrl); await fetch(stale.reviewUrl, { method: "POST", ...staleForm });
  assert.equal(f.service.reviews.status(stale.reviewId).status, "rejected");
  assert.equal(f.service.paper.status(setup.runId).view.positions[0]?.quantity, 3);
});
test("review page uses Referrer-Policy same-origin so real browsers send the origin the POST check requires", async t => {
  // Under no-referrer, browsers send `Origin: null` on the form POST and a human can never approve.
  // The real-browser proof is test/e2e/review-approval.e2e.ts; this guards the header in `npm run check`.
  const f = fixture(t); await entered(f);
  const review = await f.service.reviews.propose(setup.runId, "DEMOA", "close");
  const page = await fetch(review.reviewUrl);
  assert.equal(page.headers.get("referrer-policy"), "same-origin"); await page.text();
  assert.match(review.instruction, /Do not open, fetch or submit it yourself/);
  await fetch(review.reviewUrl, { method: "POST", ...await browserReview(review.reviewUrl) });
  const again = await fetch(review.reviewUrl, { method: "POST" });
  assert.equal(again.status, 410); assert.equal(await again.text(), "Review already executed.");
});
test("chat settings arrive in human units and are pinned to the run in internal units", async t => {
  const f = fixture(t), server = createAgentMcpServer(f.service), client = new Client({ name: "settings", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  const configure = async (args: Record<string, unknown>) => client.callTool({ name: "configure_paper_strategy", arguments: { ...setup, ...args } });
  const ok = await configure({ maxPremiumPerTradeDollars: 1000, maxPremiumPerDayDollars: 2500, minimumContracts: 5, maximumPositions: 3,
    maxOptionSpreadPercent: 2.5, feeReserveCentsPerContract: 50, entryWindowMinutes: 60 });
  assert.ok(!ok.isError, JSON.stringify(ok));
  const pinned = JSON.parse((ok.content as any)[0].text).config;
  assert.deepEqual({ ...pinned, symbols: undefined, date: undefined }, { ...pinned, symbols: undefined, date: undefined,
    budgetCentsPerPosition: 100000, budgetCentsPerDay: 250000, minimumContracts: 5, maximumContractsPerTrade: null, maximumPositions: 3,
    maxOptionSpreadFraction: .025, feeReserveCentsPerContract: 50, entryWindowMinutes: 60 });
  // Omitting every setting pins the founder's defaults: the path where behavior changed (minimum 2 -> 4, no 3/2 fallback).
  const defaults = JSON.parse(((await configure({ runId: "defaults" })).content as any)[0].text).config;
  assert.deepEqual([defaults.budgetCentsPerPosition, defaults.budgetCentsPerDay, defaults.minimumContracts, defaults.maximumContractsPerTrade,
    defaults.maximumPositions, defaults.maxOptionSpreadFraction, defaults.feeReserveCentsPerContract, defaults.entryWindowMinutes], [200000, 400000, 4, null, 2, .2, 100, 90]);
  assert.deepEqual([defaults.firstTargetMultiple, defaults.middleTargetMultiple, defaults.finalTargetMultiple, defaults.backstopFraction, defaults.stopBufferFraction,
    defaults.flattenLeadMinutes], [2, 3, 5, .5, .001, 1]);
  // Exit settings: multiples as multiples, the backstop and stop buffer in percent.
  const exits = JSON.parse(((await configure({ runId: "exits", firstTargetMultiple: 1.5, middleTargetMultiple: 2.5, finalTargetMultiple: 4,
    backstopPercent: 40, stopBufferPercent: .7, flattenLeadMinutes: 5 })).content as any)[0].text).config;
  assert.deepEqual([exits.firstTargetMultiple, exits.middleTargetMultiple, exits.finalTargetMultiple, exits.backstopFraction, exits.stopBufferFraction,
    exits.flattenLeadMinutes], [1.5, 2.5, 4, .4, .007, 5]);   // .7% pins exactly 0.007, no float noise
  assert.deepEqual([defaults.pollMs, defaults.maxQuoteAgeMs, defaults.maxObservationGapMs, defaults.rangeDeadlineMs, defaults.readFailureHaltMs],
    [1000, 5000, 5000, 60000, 60000]);
  const timing = JSON.parse(((await configure({ runId: "timing", pollSeconds: .5, maxQuoteAgeSeconds: 10, maxObservationGapSeconds: 15,
    rangeDeadlineSeconds: 90, readFailureHaltSeconds: 120 })).content as any)[0].text).config;
  assert.deepEqual([timing.pollMs, timing.maxQuoteAgeMs, timing.maxObservationGapMs, timing.rangeDeadlineMs, timing.readFailureHaltMs],
    [500, 10000, 15000, 90000, 120000]);
  assert.ok((await configure({ runId: "gap", pollSeconds: 1, maxObservationGapSeconds: 1.5 })).isError, "a gap must hold two polls");
  assert.deepEqual([defaults.maxEntryQuoteBatches, defaults.heartbeatMs], [3, 60000]);
  const entryAndJournal = JSON.parse(((await configure({ runId: "journal", maxEntryQuoteBatches: 5, heartbeatSeconds: 30 })).content as any)[0].text).config;
  assert.deepEqual([entryAndJournal.maxEntryQuoteBatches, entryAndJournal.heartbeatMs], [5, 30000]);
  const rounded = JSON.parse(((await configure({ runId: "rounded", pollSeconds: .2505 })).content as any)[0].text).config;
  assert.equal(rounded.pollMs, 251, "seconds become whole milliseconds, rounded half up");
  assert.ok((await configure({ runId: "unordered", firstTargetMultiple: 3, middleTargetMultiple: 3 })).isError, "targets must rise");
  assert.ok((await configure({ runId: "backstop", backstopPercent: 100 })).isError, "a backstop at the entry premium is not a stop");
  assert.ok((await configure({ runId: "fractional", maxPremiumPerTradeDollars: 1000.5 })).isError, "dollars must be whole");
  assert.ok((await configure({ runId: "inverted", maxPremiumPerTradeDollars: 3000, maxPremiumPerDayDollars: 2000 })).isError, "day cap below trade cap");
});
test("MCP client configures, starts, asks P&L, reviews a close, and reads the audit trail", async t => {
  const f = fixture(t), server = createAgentMcpServer(f.service), client = new Client({ name: "paper-e2e", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args }); assert.ok(!r.isError, JSON.stringify(r));
    return JSON.parse((r.content as any)[0].text);
  };
  await call("configure_paper_strategy", setup); await call("start_paper_run", { runId: setup.runId });
  f.setTime(open + 120000); await f.service.paper.tick(setup.runId); f.advance(); f.prices.DEMOA = 106; await f.service.paper.tick(setup.runId);
  assert.equal((await call("get_paper_run", { runId: setup.runId })).view.positions.length, 1);
  assert.equal((await call("get_daily_pnl", { date })).ordersSubmitted, 0);
  const review = await call("propose_position_change", { runId: setup.runId, symbol: "DEMOA", action: "close" });
  await fetch(review.reviewUrl, { method: "POST", ...await browserReview(review.reviewUrl) });
  assert.equal((await call("get_position_review", { reviewId: review.reviewId })).status, "executed");
  assert.equal((await call("get_paper_run", { runId: setup.runId })).view.positions.length, 0);
  assert.ok((await call("get_paper_events", { runId: setup.runId })).pages.length >= 4);
  await call("stop_paper_run", { runId: setup.runId });
  assert.equal((await call("list_paper_runs", {})).runs[0].status, "stopped");
});
