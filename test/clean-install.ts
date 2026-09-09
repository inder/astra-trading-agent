// Run only in disposable CI machines. Never writes the developer's real client configuration.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { installAgent } from "../src/install-agent.ts";
import { verifyRegisteredCodexClient } from "./codex-client-probe.ts";

if (process.env.GITHUB_ACTIONS !== "true") throw new Error("This acceptance script is restricted to disposable GitHub runners");
const call = (command: string, args: string[]) => {
  const r = spawnSync(command, args, { encoding: "utf8", timeout: 60000 });
  if (r.status !== 0) throw new Error(`Acceptance command failed: ${command} ${args.slice(0,2).join(" ")} (${r.status})`);
  return r.stdout;
};
assert.equal(existsSync(join(homedir(), ".codex", "config.toml")), false, "Codex config must begin empty");
assert.equal(existsSync(join(homedir(), ".claude.json")), false, "Claude config must begin empty");
// Fixtures demonstrate that adding Astra preserves pre-existing unrelated connections.
call("codex", ["mcp", "add", "astra-unrelated-fixture", "--", process.execPath, "--version"]);
const beforeCodex = JSON.parse(call("codex", ["mcp", "get", "astra-unrelated-fixture", "--json"]));
call("claude", ["mcp", "add-json", "--scope", "user", "astra-unrelated-fixture", JSON.stringify({ type: "stdio", command: process.execPath, args: ["--version"] })]);
const beforeClaude = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8")).mcpServers["astra-unrelated-fixture"];
const evidence = [];
for (const client of ["codex", "claude-code"] as const) {
  const options = { client, apply: true, dataDirectory: resolve("acceptance data", client) };
  const first = await installAgent(options), second = await installAgent(options);
  assert.equal(first.changesApplied, true); assert.equal(second.changesApplied, false);
  assert.equal(first.clientConfigurationVerified, true); assert.equal(first.storedLaunchVerified?.syntheticSample, true);
  assert.equal(first.marketStrategyStarted, false); assert.equal(first.brokerConnected, false);
  evidence.push({ client, cliVersion: call(client === "codex" ? "codex" : "claude", ["--version"]).trim(),
    registered: true, storedCommandHandshake: true, syntheticSample: true, repeatedInstallNoConfigChange: true,
    activeChatConversationTested: false, brokerAuthorized: false });
}
assert.deepEqual(JSON.parse(call("codex", ["mcp", "get", "astra-unrelated-fixture", "--json"])), beforeCodex);
assert.deepEqual(JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8")).mcpServers["astra-unrelated-fixture"], beforeClaude);
const actualClient = await verifyRegisteredCodexClient();
console.log(JSON.stringify({ platform: process.platform, freshCheckoutWithSpaces: true, preservedOtherConnections: true, evidence, actualClient }, null, 2));
