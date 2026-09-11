import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TradingAgentService } from "../src/agent-service.ts";
import { createAgentMcpServer } from "../src/agent-mcp.ts";
import { OrbPaperRuntime, sessionTimes } from "../src/orb-paper-runtime.ts";
import { openingRangeConfig } from "../src/orb-config.ts";
import type { AgentStrategy } from "../src/agent-strategies.ts";
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
test("full paper lifecycle enforces two names, budgets, option P&L, trims and stop", async t => {
  const f = fixture(t); await entered(f);
  f.advance(); f.prices.DEMOB = 106; f.prices.DEMOC = 106;
  await f.service.paper.tick(setup.runId);
  let status = f.service.paper.status(setup.runId);
  assert.equal(status.view.positions.length, 2); assert.equal(status.view.committedCents, 320800);
  f.advance(); f.prices.DEMOA = 106 * 1.05; f.prices.DEMOB = 99; f.setBid(5);
  await f.service.paper.tick(setup.runId);
  status = f.service.paper.status(setup.runId);
  assert.equal(status.view.positions.length, 1); assert.equal(status.view.positions[0]?.quantity, 3);
  assert.equal(status.view.realizedPnlCents, 50000); // five contracts, $100 each in this invented quote fixture
  assert.equal(status.view.unrealizedPnlCents, 30000);
  assert.equal(status.view.committedCents, 320800); // sales never release entry budget
  assert.equal(f.service.paper.daily(date).realizedPnlCents, 50000);
  const events = f.service.paper.events(setup.runId).flatMap(p => p.events);
  assert.equal(events.filter(e => e.type === "paper_entry").length, 2);
  assert.ok(events.some(e => e.type === "paper_sale" && (e.data as any).reason === "protective_stop"));
  assert.equal(status.ordersSubmitted, 0);
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
  assert.deepEqual(events.filter(e => e.type === "setup_disqualified").map(e => e.data), [{ symbol: "DEMOA", reason: "opening_low_failed" }]);
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
test("provider outage halts without losing the last committed paper position", async t => {
  const f = fixture(t); await entered(f); f.outage(); f.advance();
  await assert.rejects(f.service.paper.tick(setup.runId), /halted/);
  assert.equal(f.service.paper.status(setup.runId).status, "error");
  assert.equal(f.service.paper.status(setup.runId).view.positions[0]?.quantity, 4);
  assert.equal(f.service.paper.status(setup.runId).attached, false);
});
test("session-close simulation flattens only with valid quotes, otherwise reports unresolved positions", async t => {
  const f = fixture(t); await entered(f); f.setTime(close - 60000);
  await f.service.paper.tick(setup.runId);
  assert.equal(f.service.paper.status(setup.runId).view.positions.length, 0);
  f.setTime(close); await f.service.paper.tick(setup.runId);
  assert.equal(f.service.paper.status(setup.runId).status, "completed");
  await assert.rejects(f.service.paper.start(setup.runId, true), /expired/);
});
test("unfilled session-close exits remain visible rather than being marked closed", async t => {
  const f = fixture(t); await entered(f); f.staleOption(6000); f.setTime(close - 60000);
  await f.service.paper.tick(setup.runId); f.setTime(close); await f.service.paper.tick(setup.runId);
  const s = f.service.paper.status(setup.runId);
  assert.equal(s.status, "completed"); assert.equal(s.view.positions.length, 1); assert.equal(s.view.unrealizedPnlCents, null);
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
