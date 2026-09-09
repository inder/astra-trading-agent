import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TradingAgentService } from "../src/agent-service.ts";
import type { AgentStrategy } from "../src/agent-strategies.ts";

const request = { strategyId: "opening-range-options", symbols: ["DEMOA", "DEMOB", "DEMOC"], includePremarket: false, requestId: "sample-one" };
function fixture(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), "astra-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, service: new TradingAgentService(directory) };
}
test("disconnected startup and preview are honest and write nothing", t => {
  const { service, directory } = fixture(t);
  assert.equal(service.readiness().brokerage, "not_connected");
  assert.equal(service.readiness().requiresOpenAIKey, false);
  assert.equal(service.catalog().length, 1);
  assert.equal(service.preview(request.strategyId, request.symbols, false).started, false);
  assert.deepEqual(readdirSync(directory), []);
  assert.throws(() => service.preview("daily-ma-call", request.symbols, false));
  assert.throws(() => service.preview(request.strategyId, ["DEMOA", "DEMOA"], false));
  assert.throws(() => service.preview(request.strategyId, ["../../private"], false));
});
test("sample uses actual engine sizing, position cap, four trims and protective stop", t => {
  const { service } = fixture(t); const run = service.runSample(request);
  assert.equal(run.mode, "synthetic_sample"); assert.equal(run.summary.ordersSubmitted, 0);
  assert.equal(run.summary.pnl, null); assert.equal(run.summary.committedCents, 320800);
  assert.equal(run.events.filter(e => e.type === "simulated_entry").length, 2);
  const sales = run.events.filter(e => e.type === "simulated_sale").map(e => e.data as any);
  assert.equal(sales.filter(e => e.reason === "profit_trim").length, 4);
  assert.ok(sales.some(e => e.reason === "protective_stop" && e.quantity === 4));
  assert.ok(run.events.some(e => e.type === "entry_skipped" && (e.data as any).symbol === "DEMOC"));
  assert.deepEqual(run.events.map(e => e.sequence), run.events.map((_, i) => i + 1));
});
test("idempotent run survives restart and rejects conflicting retries", t => {
  const { service, directory } = fixture(t); const run = service.runSample(request);
  const persisted = readFileSync(join(directory, "runs", "sample-one.json"), "utf8");
  const restarted = new TradingAgentService(directory);
  assert.deepEqual(restarted.runSample(request), run);
  assert.equal(readFileSync(join(directory, "runs", "sample-one.json"), "utf8"), persisted);
  assert.throws(() => restarted.runSample({ ...request, symbols: ["OTHER"] }), /different configuration/);
  assert.equal(restarted.listRuns().length, 1);
  assert.deepEqual(readdirSync(join(directory, "runs")), ["sample-one.json"]);
});
test("bad run IDs, symlinks and corrupt records fail closed", t => {
  const { service, directory } = fixture(t);
  assert.throws(() => service.getRun("../secret"));
  assert.throws(() => service.runSample({ ...request, requestId: "../secret" }));
  service.runSample(request);
  symlinkSync(join(directory, "runs", "sample-one.json"), join(directory, "runs", "alias.json"));
  assert.throws(() => service.getRun("alias"));
  writeFileSync(join(directory, "runs", "sample-one.json"), "broken");
  assert.throws(() => service.runSample(request));
  assert.equal(readFileSync(join(directory, "runs", "sample-one.json"), "utf8"), "broken");
});
test("second plug-in works without changing service or transport", t => {
  const { directory } = fixture(t);
  const plugin: AgentStrategy = { id: "test-only", version: "1.2.3", name: "Test fixture", description: "Not a trading strategy",
    capabilities: ["synthetic_sample"], preview: input => input,
    runSample: config => ({ events: [{ sequence: 1, type: "test", data: config }], summary: { ordersSubmitted: 0 } }) };
  const service = new TradingAgentService(directory, [plugin]);
  const run = service.runSample({ ...request, strategyId: plugin.id });
  assert.equal(run.strategyVersion, "1.2.3"); assert.equal(service.catalog()[0]!.id, plugin.id);
  assert.throws(() => new TradingAgentService(directory, [plugin, plugin]));
});
