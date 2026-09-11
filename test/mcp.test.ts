import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { TradingAgentService } from "../src/agent-service.ts";
import { agentHttpServer } from "../src/agent-server.ts";
import type { AddressInfo } from "node:net";
import { request as httpRequest } from "node:http";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAgentMcpServer } from "../src/agent-mcp.ts";
import { MARKET_READS } from "../src/broker-connection.ts";
import { brokerFixture, callback } from "./broker-fixture.ts";

const unpack = (r: any) => JSON.parse(r.content[0].text);
test("guided setup through MCP: the guide leads from install to a saved plan, and nothing starts on its own", async t => {
  const dir = mkdtempSync(join(tmpdir(), "astra-guided-"));
  const broker = brokerFixture({ listing: MARKET_READS.map(name => ({ name })) });
  const chainReads: string[] = [];
  const symbols = { quotes: async (s: string[]) => s.map(symbol => ({ symbol, price: 50, tradeAt: "2026-09-14T11:59:00.000Z", retrievedAt: "2026-09-14T12:00:00.000Z",
    ageMs: 60000, fresh: false, regularSession: false, state: "active", bid: null, ask: null })),
    listedExpirations: async (s: string) => { chainReads.push(s); return s === "DEMOB" ? ["2026-09-16"] : ["2026-09-16", "2026-09-18"]; } };
  // 8:00 AM New York time on Monday 14 September 2026: today's session can still be planned and started.
  const service = new TradingAgentService(dir, undefined, broker.connection, { symbols, clock: () => Date.parse("2026-09-14T08:00:00-04:00"), auto: false });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createAgentMcpServer(service), client = new Client({ name: "guided-test", version: "1" });
  t.after(async () => { await client.close(); await server.close(); await service.close(); rmSync(dir, { recursive: true, force: true }); });
  await server.connect(serverSide); await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown> = {}) => unpack(await client.callTool({ name, arguments: args }));

  let guide = (await call("get_readiness")).guide;
  assert.equal(guide.stage, "connect_robinhood"); assert.deepEqual(guide.next, { tool: "connect_robinhood", when: "now" });
  const checkedEarly = await client.callTool({ name: "check_symbols", arguments: { symbols: ["DEMOA"] } });
  assert.equal(checkedEarly.isError, true); assert.equal(unpack(checkedEarly).next.stage, "connect_robinhood");   // errors still lead
  const link = await call("connect_robinhood");
  assert.match(link.authorizationUrl, /^https:\/\/robinhood\.com\/oauth/); assert.equal(link.next.stage, "awaiting_robinhood");
  assert.equal((await call("wait_for_robinhood", { seconds: 1 })).outcome, "still_waiting");
  // The user approves in the browser while the model waits: no "done" message needed.
  const waiting = call("wait_for_robinhood", { seconds: 10 });
  assert.equal((await fetch(callback(link.authorizationUrl, broker.redirect()))).status, 200);
  const approved = await waiting;
  assert.equal(approved.outcome, "connected"); guide = approved.next;
  assert.equal(guide.stage, "choose_symbols"); assert.equal(guide.session.date, "2026-09-14"); assert.equal(guide.runId, "orb-2026-09-14");
  const bad = await client.callTool({ name: "wait_for_robinhood", arguments: { seconds: 41 } });
  assert.equal(bad.isError, true);   // over the per-call ceiling

  const checked = await call("check_symbols", { symbols: ["DEMOA", "DEMOB"] });
  assert.deepEqual(checked.symbols.map((s: any) => [s.symbol, s.usable, s.problem]), [["DEMOA", true, null], ["DEMOB", false, "no_qualifying_expiry"]]);
  assert.match(checked.problems.no_qualifying_expiry, /week-ending expiry/); assert.deepEqual(chainReads, ["DEMOA", "DEMOB"]);
  assert.equal(checked.next.stage, "choose_symbols");
  const saved = await call("configure_paper_strategy", { runId: guide.runId, strategyId: "opening-range-options", date: guide.session.date,
    symbols: ["DEMOA"], includePremarket: false });
  assert.equal(saved.status, "configured");
  assert.equal(saved.next.stage, "start_run"); assert.deepEqual(saved.next.next, { tool: "start_paper_run", when: "after_user_yes", args: { runId: "orb-2026-09-14" } });
  assert.equal((await call("get_readiness")).guide.stage, "start_run");
  assert.deepEqual((await call("list_paper_runs")).runs.map((r: any) => r.status), ["configured"]);   // saved, not started
  assert.deepEqual(broker.calls, []);   // no market reads were made through the broker by any of this
});
test("real stdio MCP handshake, schema checks, sample and resource without credentials", async t => {
  const dir = mkdtempSync(join(tmpdir(), "astra-stdio-"));
  const client = new Client({ name: "integration-test", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [resolve("src/agent-server.ts"), "--data-dir", dir], env: { PATH: process.env.PATH ?? "" }, stderr: "pipe" });
  t.after(async () => { await client.close(); rmSync(dir, { recursive: true, force: true }); });
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 21);
  assert.ok(!tools.some(t => /close|sell|buy|live|shell|credential/.test(t.name)));
  // Clients that pass server instructions to their model are told to lead with get_readiness's guide.
  assert.match(client.getInstructions() ?? "", /call get_readiness and follow its guide/);
  assert.match(tools.find(t => t.name === "get_readiness")!.description!, /^Call this first/);
  const readiness = unpack(await client.callTool({ name: "get_readiness", arguments: {} }));
  // The stage depends on today's date (the guided flow is pinned to a fixed clock in its own test above).
  assert.equal(readiness.brokerage, "not_connected"); assert.equal(typeof readiness.guide.stage, "string");
  const bad = await client.callTool({ name: "run_sample", arguments: { requestId: "../x" } });
  assert.equal(bad.isError, true);
  const result = unpack(await client.callTool({ name: "run_sample", arguments: {
    strategyId: "opening-range-options", symbols: ["DEMOA", "DEMOB"], requestId: "stdio-test", includePremarket: false,
  } }));
  assert.equal(result.summary.ordersSubmitted, 0);
  const detail = unpack(await client.callTool({ name: "get_run", arguments: { runId: result.id } }));
  assert.ok(detail.events.length > 5);
  assert.equal((await client.readResource({ uri: "trading-agent://readiness" })).contents.length, 1);
});
test("HTTP rejects unauthenticated, cross-origin, hostile-host and oversized requests; authenticated MCP works", async t => {
  const dir = mkdtempSync(join(tmpdir(), "astra-http-"));
  const token = "test-only-token-not-a-real-secret-123456789";
  assert.throws(() => agentHttpServer(new TradingAgentService(dir), "short"));
  const server = agentHttpServer(new TradingAgentService(dir), token);
  await new Promise<void>(ok => server.listen(0, "127.0.0.1", ok));
  t.after(async () => {
    server.closeAllConnections(); await new Promise<void>((ok, fail) => server.close(error => error ? fail(error) : ok()));
    rmSync(dir, { recursive: true, force: true });
  });
  const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  assert.equal((await fetch(url, { method: "POST" })).status, 401);
  assert.equal((await fetch(url, { method: "POST", headers: { ...headers, origin: "https://untrusted.invalid" } })).status, 403);
  const hostileHostStatus = await new Promise<number | undefined>((ok, fail) => {
    const req = httpRequest(url, { method: "POST", headers: { ...headers, host: "untrusted.invalid" } }, res => {
      res.resume(); res.on("end", () => ok(res.statusCode));
    });
    req.on("error", fail); req.end("{}");
  });
  assert.equal(hostileHostStatus, 403);
  assert.equal((await fetch(url, { method: "POST", headers, body: "{" })).status, 400);
  assert.equal((await fetch(url, { method: "POST", headers, body: "x".repeat(70000) })).status, 413);
  const client = new Client({ name: "http-test", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    assert.equal((await client.listTools()).tools.length, 21);
    assert.equal(unpack(await client.callTool({ name: "get_readiness", arguments: {} })).mode, "sample_and_paper");
  } finally { await client.close(); }
});
