#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { probeRegisteredServer, registrationPlan, verifyInstallation } from "./setup.ts";

export type InstallClient = "codex" | "claude-code" | "claude-desktop";
type Result = { status: number | null; stdout: string; stderr: string };
type Runner = (command: string, args: string[]) => Result;
const run: Runner = (command, args) => {
  const r = spawnSync(command, args, { encoding: "utf8", timeout: 30000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  if (r.error) throw new Error("Client CLI unavailable or timed out. Install/locate the official CLI and retry.");
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};
const name = "astra-trading-agent";
const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function read(path: string): string | null {
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { return readFileSync(fd, "utf8"); } finally { closeSync(fd); }
  } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw new Error("Client configuration could not be read safely"); }
}
function json(text: string | null): Record<string, any> {
  const value = text === null ? {} : JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value) || (value.mcpServers !== undefined &&
    (!value.mcpServers || typeof value.mcpServers !== "object" || Array.isArray(value.mcpServers)))) throw new Error("Invalid client JSON configuration");
  return value;
}
function defaultPath(client: InstallClient) {
  if (client === "codex") return join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml");
  if (client === "claude-code") return join(process.env.CLAUDE_CONFIG_DIR ?? homedir(), ".claude.json");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (process.platform === "win32" && process.env.APPDATA) return join(process.env.APPDATA, "Claude", "claude_desktop_config.json");
  throw new Error("Claude Desktop automatic config location is supported on macOS/Windows only; use a verified client configuration path.");
}
function matches(entry: any, expected: { command: string; args: string[] }) {
  const transport = entry?.transport ?? entry;
  return entry?.enabled !== false && transport && (transport.type === undefined || transport.type === "stdio") &&
    transport.command === expected.command && JSON.stringify(transport.args) === JSON.stringify(expected.args) &&
    (!transport.env || Object.keys(transport.env).length === 0) && (!transport.env_vars || transport.env_vars.length === 0) &&
    !transport.cwd && !entry.disabled_tools?.length && !entry.enabled_tools?.length;
}
function backup(path: string, contents: string | null) {
  if (contents === null) return;
  const folder = join(dirname(path), "astra-install-backups");
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  if (lstatSync(folder).isSymbolicLink() || !lstatSync(folder).isDirectory()) throw new Error("Unsafe backup location");
  writeFileSync(join(folder, `before-${Date.now()}-${randomUUID()}.backup`), contents, { flag: "wx", mode: 0o600 });
}
function saveJson(path: string, original: string | null, value: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = path + ".astra-" + randomUUID();
  const fd = openSync(tmp, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  try {
    if (read(path) !== original) throw new Error("Client settings changed during installation; retry after the other writer finishes");
    renameSync(tmp, path);
  } finally { if (existsSync(tmp)) unlinkSync(tmp); }
}

/** Explicit local installer; never exposed over MCP. Preview is the default. */
export async function installAgent(options: { client: InstallClient; apply: boolean; dataDirectory?: string },
  testing: { configPath?: string; runner?: Runner; preflight?: typeof verifyInstallation; probe?: typeof probeRegisteredServer } = {}) {
  if (!["codex", "claude-code", "claude-desktop"].includes(options.client)) throw new Error("Choose a supported client");
  const runner = testing.runner ?? run;
  const plan = registrationPlan(project, process.execPath, options.dataDirectory);
  const expected = { command: plan.command, args: plan.args };
  const path = testing.configPath ?? defaultPath(options.client);
  const before = read(path);
  const doc = options.client === "codex" ? null : json(before);
  let old: any;
  const getCodex = () => {
    const r = runner("codex", ["mcp", "get", name, "--json"]);
    if (r.status === 0) return JSON.parse(r.stdout);
    if (r.status === 1 && r.stderr.includes(`No MCP server named '${name}' found`)) return undefined;
    throw new Error("Could not inspect Codex MCP settings; no configuration change made");
  };
  old = options.client === "codex" ? getCodex() : doc!.mcpServers?.[name];
  if (old && !matches(old, expected)) throw new Error("An Astra entry already exists with different settings. Review it explicitly; installation will not overwrite it.");
  if (!options.apply) return { client: options.client, mode: "preview", changesApplied: false, alreadyConfigured: !!old,
    registration: expected, next: "Run again with --apply only when installation in this client is authorized." };
  const check = await (testing.preflight ?? verifyInstallation)();
  // Re-check before a write: don't race a concurrently edited settings file.
  if (read(path) !== before) throw new Error("Client settings changed during verification; retry");
  if (!old) {
    backup(path, before);
    if (options.client === "claude-desktop") {
      saveJson(path, before, { ...doc, mcpServers: { ...doc!.mcpServers, [name]: expected } });
    } else {
      const result = options.client === "codex" ? runner("codex", plan.codex.args) :
        runner("claude", ["mcp", "add-json", "--scope", "user", name, JSON.stringify({ type: "stdio", ...expected })]);
      if (result.status !== 0) throw new Error("Client registration failed. Inspect its settings before retrying; any pre-existing configuration was backed up.");
    }
  }
  const after = options.client === "codex" ? getCodex() : json(read(path)).mcpServers?.[name];
  if (!matches(after, expected)) throw new Error("Registered settings differ from the verified plan; inspect the client before retrying");
  // Test exactly the stored launch command, not only an independently generated fragment.
  const transport = after.transport ?? after;
  const storedLaunch = await (testing.probe ?? probeRegisteredServer)(transport.command, transport.args);
  return { client: options.client, mode: "installed", changesApplied: !old, alreadyConfigured: !!old,
    clientConfigurationVerified: true, storedLaunchVerified: storedLaunch, preflight: check.verified,
    activeChatToolsVerified: false, brokerConnected: false, marketStrategyStarted: false,
    next: "Reload this client's MCP connection if needed and call get_readiness from the chat. The host may request permission. Robinhood authorization remains a separate user step." };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2); let client: InstallClient | undefined, apply = false, dataDirectory: string | undefined;
  try {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--apply") apply = true;
      else if (args[i] === "--client" && args[i + 1]) client = args[++i] as InstallClient;
      else if (args[i] === "--data-dir" && args[i + 1]) dataDirectory = resolve(args[++i]!);
      else throw new Error("Usage: npm run install-agent -- --client codex|claude-code|claude-desktop [--apply] [--data-dir DIRECTORY]");
    }
    if (!client) throw new Error("A client is required; use --client codex, claude-code or claude-desktop");
    await installAgent({ client, apply, dataDirectory }).then(r => console.log(JSON.stringify(r, null, 2)));
  } catch (e) { console.error(e instanceof SyntaxError ? "Invalid client configuration; no automatic repair attempted" : e instanceof Error ? e.message : "Installation failed"); process.exitCode = 1; }
}
