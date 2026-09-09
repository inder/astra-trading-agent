import { test } from "node:test";
import assert from "node:assert/strict";
import { registrationPlan, verifyInstallation } from "../src/setup.ts";
import { resolve } from "node:path";

test("setup produces literal argument arrays and never modifies client configuration", () => {
  const root = resolve("example folder with spaces"), node = resolve("node executable"), data = resolve("private data");
  const plan = registrationPlan(root, node, data);
  assert.equal(plan.changesApplied, false);
  assert.deepEqual(plan.codex.args.slice(4), [node, ...plan.args]);
  assert.deepEqual(plan.claudeDesktop.mcpServers["astra-trading-agent"], { command: node, args: plan.args });
  assert.throws(() => registrationPlan("relative", node, data));
  assert.throws(() => registrationPlan(root, node, data + "\n"));
});
test("setup verifies a real isolated MCP server and synthetic sample without broker access", async () => {
  const result = await verifyInstallation();
  assert.equal(result.verified.localMcpHandshake, true); assert.equal(result.verified.syntheticSample, true);
  assert.equal(result.brokerConnected, false); assert.equal(result.marketStrategyStarted, false);
  assert.equal(result.actualClientConnectionVerified, false); assert.equal(result.registration.changesApplied, false);
});
