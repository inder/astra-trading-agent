import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installAgent, type InstallClient } from "../src/install-agent.ts";

function fixture(t: TestContext, client: InstallClient = "claude-desktop") {
  const directory = mkdtempSync(join(tmpdir(), "astra-install-test-")), path = join(directory, "client-config.json");
  const other = { mcpServers: { unrelated: { command: "fixture-command", args: ["fixture-only-secret"] } }, preference: "preserve-me" };
  writeFileSync(path, JSON.stringify(other));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let preflightCalls = 0, probes = 0;
  const testing = { configPath: path, preflight: async () => { preflightCalls++; return { verified: { syntheticSample: true } } as any; },
    probe: async () => { probes++; return { syntheticSample: true } as any; } };
  return { path, directory, other, testing, options: { client, apply: true, dataDirectory: join(directory, "paper data") }, counts: () => ({ preflightCalls, probes }) };
}
test("preview never writes settings or launches a server", async t => {
  const f = fixture(t); const before = readFileSync(f.path, "utf8");
  const result = await installAgent({ ...f.options, apply: false }, f.testing);
  assert.equal(result.changesApplied, false); assert.equal(readFileSync(f.path, "utf8"), before);
  assert.deepEqual(f.counts(), { preflightCalls: 0, probes: 0 });
});
test("desktop installation merges one entry, preserves unrelated settings and privately backs up", async t => {
  const f = fixture(t); const result = await installAgent(f.options, f.testing);
  assert.equal(result.clientConfigurationVerified, true); assert.equal(result.activeChatToolsVerified, false);
  // One instruction for the user; after the restart Astra's own guide leads.
  assert.ok("tellUser" in result);
  assert.equal(result.tellUser, "Quit Claude Desktop completely and reopen it, then send any message (for example, \"hi\"). " +
    "Astra will guide you from there: connecting Robinhood market data, choosing stocks, and starting a paper run.");
  const saved = JSON.parse(readFileSync(f.path, "utf8"));
  assert.deepEqual(saved.mcpServers.unrelated, f.other.mcpServers.unrelated); assert.equal(saved.preference, "preserve-me");
  const backups = readdirSync(join(f.directory, "astra-install-backups")); assert.equal(backups.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(f.directory, "astra-install-backups", backups[0]!), "utf8")), f.other);
  const before = readFileSync(f.path, "utf8"); const second = await installAgent(f.options, f.testing);
  assert.equal(second.changesApplied, false); assert.equal(second.alreadyConfigured, true);
  assert.equal(readFileSync(f.path, "utf8"), before);
});
test("a conflicting existing Astra connection is never overwritten", async t => {
  const f = fixture(t); writeFileSync(f.path, JSON.stringify({ mcpServers: { "astra-trading-agent": { command: "other", args: [] } } }));
  const before = readFileSync(f.path, "utf8");
  await assert.rejects(installAgent(f.options, f.testing), /will not overwrite/);
  assert.equal(readFileSync(f.path, "utf8"), before); assert.equal(f.counts().preflightCalls, 0);
});
test("malformed configuration and failed preflight leave the original untouched", async t => {
  const f = fixture(t); writeFileSync(f.path, "invalid-json");
  await assert.rejects(installAgent(f.options, f.testing)); assert.equal(readFileSync(f.path, "utf8"), "invalid-json");
  writeFileSync(f.path, "{}");
  await assert.rejects(installAgent(f.options, { ...f.testing, preflight: async () => { throw new Error("unavailable runtime"); } }), /runtime/);
  assert.equal(readFileSync(f.path, "utf8"), "{}");
});
test("concurrent configuration changes abort before registration", async t => {
  const f = fixture(t);
  await assert.rejects(installAgent(f.options, { ...f.testing, preflight: async () => {
    writeFileSync(f.path, '{"newPreference":true}'); return { verified: {} } as any;
  } }), /changed during verification/);
  assert.equal(readFileSync(f.path, "utf8"), '{"newPreference":true}');
});
test("Codex registration uses literal CLI arguments and verifies the persisted transport", async t => {
  const f = fixture(t, "codex"); let saved: any; let writes = 0;
  const runner = (_command: string, args: string[]) => {
    if (args[1] === "get") return saved ? { status: 0, stdout: JSON.stringify(saved), stderr: "" } :
      { status: 1, stdout: "", stderr: "Error: No MCP server named 'astra-trading-agent' found." };
    assert.equal(args[1], "add"); assert.equal(args[3], "--"); writes++;
    saved = { enabled: true, transport: { type: "stdio", command: args[4], args: args.slice(5), env: null } };
    return { status: 0, stdout: "", stderr: "" };
  };
  const testing = { ...f.testing, runner };
  assert.equal((await installAgent(f.options, testing)).changesApplied, true);
  assert.equal((await installAgent(f.options, testing)).changesApplied, false); assert.equal(writes, 1);
});
test("Claude Code registration uses user scope and preserves the existing JSON", async t => {
  const f = fixture(t, "claude-code");
  const runner = (command: string, args: string[]) => {
    assert.equal(command, "claude"); assert.deepEqual(args.slice(0,5), ["mcp", "add-json", "--scope", "user", "astra-trading-agent"]);
    const old = JSON.parse(readFileSync(f.path, "utf8"));
    writeFileSync(f.path, JSON.stringify({ ...old, mcpServers: { ...old.mcpServers, "astra-trading-agent": JSON.parse(args[5]!) } }));
    return { status: 0, stdout: "", stderr: "" };
  };
  assert.equal((await installAgent(f.options, { ...f.testing, runner })).clientConfigurationVerified, true);
  assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")).mcpServers.unrelated, f.other.mcpServers.unrelated);
});
