#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { homedir, tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { VERSION } from "./version.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export function registrationPlan(projectRoot = root, node = process.execPath, data = join(homedir(), ".trading-agent")) {
  if (![projectRoot, node, data].every(p => isAbsolute(p) && !/[\x00-\x1f]/.test(p))) throw new Error("Absolute, control-free paths required");
  const args = [join(projectRoot, "src", "agent-server.ts"), "--data-dir", data];
  return { serverName: "astra-trading-agent", transport: "stdio", command: node, args,
    codex: { command: "codex", args: ["mcp", "add", "astra-trading-agent", "--", node, ...args] },
    claudeDesktop: { mcpServers: { "astra-trading-agent": { command: node, args } } },
    changesApplied: false, lifecycle: "Client-owned process; no background service installed" };
}
export async function probeRegisteredServer(command: string, args: string[]) {
  const client = new Client({ name: "astra-installation-check", version: VERSION });
  const transport = new StdioClientTransport({ command, args, env: { PATH: process.env.PATH ?? "" }, stderr: "pipe" });
  try {
    await client.connect(transport, { timeout: 10000 });
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 10000 });
      if (response.isError || !Array.isArray(response.content) || response.content[0]?.type !== "text") throw new Error("Installation check failed");
      return JSON.parse(response.content[0].text);
    };
    const readiness = await call("get_readiness", {}), catalog = await call("list_strategies", {});
    const sample = await call("run_sample", { strategyId: "opening-range-options", symbols: ["DEMOA", "DEMOB"], includePremarket: false, requestId: `install-${randomUUID()}` });
    if (readiness.brokerage !== "not_connected" || sample.mode !== "synthetic_sample" || sample.summary.ordersSubmitted !== 0) throw new Error("Unexpected installation mode");
    return { node: process.versions.node, localMcpHandshake: true, syntheticSample: true, strategyCount: catalog.strategies.length };
  } finally { await client.close(); }
}
export async function verifyInstallation() {
  if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Node 24 or newer required");
  const directory = mkdtempSync(join(tmpdir(), "astra-setup-check-"));
  try {
    const verified = await probeRegisteredServer(process.execPath, [join(root, "src", "agent-server.ts"), "--data-dir", directory]);
    return { verified,
      registration: registrationPlan(), brokerConnected: false, marketStrategyStarted: false, actualClientConnectionVerified: false,
      next: "Register only this server using the target client's supported settings, then verify from that client. Robinhood consent is a separate user step." };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 2) { console.error("Setup takes no arguments and never changes client settings."); process.exitCode = 1; }
  else verifyInstallation().then(result => console.log(JSON.stringify(result, null, 2))).catch(() => {
    console.error("Installation verification failed. Check Node 24+, npm ci and npm run check. No client settings were changed."); process.exitCode = 1;
  });
}
