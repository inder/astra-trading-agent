import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TradingAgentService } from "../src/agent-service.ts";
import { createAgentMcpServer } from "../src/agent-mcp.ts";
import { sessionTimes } from "../src/daily-history.ts";
import { ReplayMarket } from "../src/replay-market.ts";
import { DAY, referenceBars, runawayDailies } from "./box-fixture.ts";

const unpack = (r: any) => JSON.parse(r.content[0].text);
test("a support-box run is configured with its own settings through MCP, watched through the day, and read back with get_support_setups", async t => {
  const dir = mkdtempSync(join(tmpdir(), "astra-box-mcp-")), { open, close } = sessionTimes(DAY);
  let now = open - 60000;
  const market = new ReplayMarket({ regular: { data: { results: [{ symbol: "SOXL", interval: "minute", bounds: "regular", bars: referenceBars() }] } },
    clock: () => now, volatility: {}, daily: { SOXL: runawayDailies() } });
  const service = new TradingAgentService(dir, undefined, undefined, { market, clock: () => now, ready: () => true, auto: false });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair(), server = createAgentMcpServer(service), client = new Client({ name: "box-test", version: "1" });
  t.after(async () => { await client.close(); await server.close(); await service.close(); rmSync(dir, { recursive: true, force: true }); });
  await server.connect(serverSide); await client.connect(clientSide);
  const raw = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  const call = async (name: string, args: Record<string, unknown> = {}) => unpack(await raw(name, args));

  const tools = (await client.listTools()).tools, configure = tools.find(t => t.name === "configure_paper_strategy")!;
  for (const name of ["maxBoxHeightAtr", "riskDollars", "minCandleTrades", "pollSeconds", "maxPremiumPerTradeDollars"]) assert.ok((configure.inputSchema.properties as any)[name], `${name} is a setting`);
  assert.ok(tools.find(t => t.name === "get_support_setups")!.annotations?.readOnlyHint);
  assert.ok(!tools.some(t => /close|sell|buy|live|shell|credential/.test(t.name)));

  const wrong = await raw("configure_paper_strategy", { runId: "box-wrong", strategyId: "support-box", date: DAY, symbols: ["SOXL"], includePremarket: false, firstTargetMultiple: 3 });
  assert.equal(wrong.isError, true); assert.match(unpack(wrong).error, /does not apply to strategy support-box/);
  const other = await raw("configure_paper_strategy", { runId: "orb-wrong", strategyId: "opening-range-options", date: DAY, symbols: ["SOXL"], includePremarket: false, maxBoxHeightAtr: 0.3 });
  assert.equal(other.isError, true); assert.match(unpack(other).error, /does not apply to strategy opening-range-options/);
  const premarket = await raw("configure_paper_strategy", { runId: "box-pre", strategyId: "support-box", date: DAY, symbols: ["SOXL"], includePremarket: true });
  assert.equal(premarket.isError, true);

  const saved = await call("configure_paper_strategy", { runId: "box-run", strategyId: "support-box", date: DAY, symbols: ["SOXL"], includePremarket: false, riskDollars: 400, heartbeatSeconds: 600 });
  assert.equal(saved.config.riskCents, 40000); assert.equal(saved.config.maxBoxHeightAtr, 0.25);
  await service.paper.start("box-run");
  for (let guard = 0; guard < 30000; guard++) { const s = await service.paper.tick("box-run"); if (s.status === "completed") break; now += 1000; if (now > close + 3600000) break; }

  const out = await call("get_support_setups", { runId: "box-run" });
  assert.deepEqual([out.watchOnly, out.ordersSubmitted, out.positions, out.runStatus], [true, 0, 0, "completed"]);
  const soxl = out.symbols.find((s: any) => s.symbol === "SOXL");
  assert.equal(soxl.verdict.status, "runaway"); assert.ok(soxl.supports.supports.length > 0);
  assert.deepEqual(soxl.boxes.map((b: any) => [b.outcome, b.decision.direction, b.decision.close]), [["decided", "up", 160.71]]);
  assert.equal(soxl.boxes[0].entries.A.shares, Math.floor(40000 / 100 / 0.535), "the run's own risk setting sizes the journaled shares");
  const orb = await call("configure_paper_strategy", { runId: "orb-run", strategyId: "opening-range-options", date: "2026-09-08", symbols: ["DEMOA"], includePremarket: false });
  const notBox = await raw("get_support_setups", { runId: orb.runId });
  assert.equal(notBox.isError, true); assert.match(unpack(notBox).error, /not a support-box run/);
});

test("a run stopped while a box is open reports that box as unresolved, never as live", async t => {
  const dir = mkdtempSync(join(tmpdir(), "astra-box-stop-")), { open } = sessionTimes(DAY);
  let now = open - 60000;
  const market = new ReplayMarket({ regular: { data: { results: [{ symbol: "SOXL", interval: "minute", bounds: "regular", bars: referenceBars() }] } },
    clock: () => now, volatility: {}, daily: { SOXL: runawayDailies() } });
  const service = new TradingAgentService(dir, undefined, undefined, { market, clock: () => now, ready: () => true, auto: false });
  t.after(async () => { await service.close(); rmSync(dir, { recursive: true, force: true }); });
  service.paper.configure({ runId: "box-stop", strategyId: "support-box", date: DAY, symbols: ["SOXL"], includePremarket: false, heartbeatMs: 600000 });
  await service.paper.start("box-stop");
  // Tick to 10:05, after the box formed (about 9:54) and before the candle that decides it (ends 10:14), then stop.
  for (now = open - 60000; now < open + 35 * 60000; now += 1000) await service.paper.tick("box-stop");
  await service.paper.stop("box-stop");
  const out = service.supportSetups("box-stop"), boxes = out.symbols[0]!.boxes as unknown as { outcome: string }[];
  assert.deepEqual(boxes.map(b => b.outcome), ["unresolved"]); assert.equal(out.runStatus, "stopped");
});
