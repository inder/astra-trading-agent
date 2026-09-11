// Actual Codex client loading, not an independent MCP SDK probe. Disposable CI only.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

export async function verifyRegisteredCodexClient() {
  if (process.env.GITHUB_ACTIONS !== "true") throw new Error("Client probe is restricted to disposable GitHub runners");
  const child = spawn("codex", ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  let sequence = 0;
  const lines = createInterface({ input: child.stdout });
  // Drain diagnostics without exposing any client configuration or unrelated tool data.
  child.stderr.resume();
  const fail = (e: Error) => { for (const q of pending.values()) { clearTimeout(q.timer); q.reject(e); } pending.clear(); };
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.on("exit", () => fail(new Error("Codex client exited before verification completed")));
  lines.on("line", line => {
    let message: any; try { message = JSON.parse(line); } catch { return; }
    const q = pending.get(message.id); if (!q) return;
    pending.delete(message.id); clearTimeout(q.timer);
    if (message.error) q.reject(new Error("Codex protocol request failed: " + JSON.stringify(message.error)));
    else q.resolve(message.result);
  });
  function request(method: string, params: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("Codex verification timeout: " + method)); }, 30000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }
  try {
    await request("initialize", { clientInfo: { name: "astra_clean_install", version: "1.0.0" }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    const thread = await request("thread/start", { cwd: process.cwd(), ephemeral: true });
    const threadId = thread.thread.id;
    // Codex starts MCP servers asynchronously; a single read right after thread/start can still say "starting".
    // Poll until startup settles (up to 30 s), then require "connected" — a failed or missing server still fails.
    let server: any;
    for (let attempt = 0; attempt < 60; attempt++) {
      const inventory = await request("mcpServerStatus/list", { threadId });
      server = inventory.data.find((item: any) => item.name === "astra-trading-agent");
      if (server?.runtimeStatus !== "starting") break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.equal(server?.runtimeStatus, "connected");
    for (const name of ["get_readiness", "list_strategies", "run_sample"]) assert.ok(server.tools[name]);
    async function call(tool: string, args: unknown) {
      const result = await request("mcpServer/tool/call", { threadId, server: "astra-trading-agent", tool, arguments: args });
      assert.notEqual(result.isError, true);
      return JSON.parse(result.content.find((item: any) => item.type === "text").text);
    }
    const readiness = await call("get_readiness", {});
    assert.equal(readiness.brokerage, "not_connected");
    assert.equal(readiness.brokerDetails.orderSubmissionEnabled, false);
    const catalog = await call("list_strategies", {});
    const strategy = catalog.strategies.find((item: any) => item.capabilities.includes("synthetic_sample"));
    assert.ok(strategy);
    const sample = await call("run_sample", { strategyId: strategy.id, symbols: ["DEMOA", "DEMOB"], requestId: randomUUID() });
    assert.equal(sample.mode, "synthetic_sample");
    assert.equal(sample.summary.ordersSubmitted, 0);
    return { actualCodexClientConnected: true, clientToolCalls: ["get_readiness", "list_strategies", "run_sample"],
      syntheticSample: true, realOrdersSubmitted: 0, authenticatedModelConversation: false };
  } finally {
    fail(new Error("Verification complete")); lines.close(); child.stdin.end();
    // Closing stdin permits normal cleanup; force only this child if it doesn't exit.
    if (child.exitCode === null) await new Promise<void>(resolve => {
      const timer = setTimeout(() => { child.kill("SIGTERM"); resolve(); }, 2000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
}
