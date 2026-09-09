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

const unpack = (r: any) => JSON.parse(r.content[0].text);
test("real stdio MCP handshake, schema checks, sample and resource without credentials", async t => {
  const dir = mkdtempSync(join(tmpdir(), "astra-stdio-"));
  const client = new Client({ name: "integration-test", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [resolve("src/agent-server.ts"), "--data-dir", dir], env: { PATH: process.env.PATH ?? "" }, stderr: "pipe" });
  t.after(async () => { await client.close(); rmSync(dir, { recursive: true, force: true }); });
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 6);
  assert.ok(!tools.some(t => /close|sell|buy|live|shell|credential/.test(t.name)));
  assert.equal(unpack(await client.callTool({ name: "get_readiness", arguments: {} })).brokerage, "not_connected");
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
    assert.equal((await client.listTools()).tools.length, 6);
    assert.equal(unpack(await client.callTool({ name: "get_readiness", arguments: {} })).mode, "sample_only");
  } finally { await client.close(); }
});
