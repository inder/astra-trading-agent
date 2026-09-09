import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TradingAgentService } from "./agent-service.ts";

export function createAgentMcpServer(service: TradingAgentService): McpServer {
  const server = new McpServer({ name: "astra-trading-agent", version: "0.2.0" });
  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  const reply = (result: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(result) }] });
  const guarded = (action: () => unknown) => {
    try { return reply(action()); }
    catch (error) {
      // Filesystem errors must not leak paths, machine details or stored contents.
      const code = (error as NodeJS.ErrnoException).code;
      return { ...reply({ error: error instanceof SyntaxError ? "Saved run is unreadable" : code ? (code === "ENOENT" ? "Run not found" : "Run storage unavailable") :
        error instanceof Error ? error.message : "Request failed" }), isError: true };
    }
  };
  server.registerTool("get_readiness", { description: "Discover available capabilities and onboarding prerequisites. No credentials required.",
    inputSchema: z.object({}).strict(), annotations: readOnly }, () => reply(service.readiness()));
  server.registerTool("list_strategies", { description: "List versioned strategies supported by this installation, not by other legacy programs.",
    inputSchema: z.object({}).strict(), annotations: readOnly }, () => reply({ strategies: service.catalog() }));
  const configSchema = {
    strategyId: z.string().min(1).max(80),
    symbols: z.array(z.string().regex(/^[A-Z][A-Z0-9.-]{0,9}$/)).min(1).max(20),
    includePremarket: z.boolean().default(false),
  };
  server.registerTool("preview_strategy", { description: "Validate a synthetic-sample configuration without saving or starting it. Dataset date is fixed, not today.",
    inputSchema: z.object(configSchema).strict(), annotations: readOnly }, a => guarded(() => service.preview(a.strategyId, a.symbols, a.includePremarket)));
  server.registerTool("run_sample", { description: "Run invented sample prices through the strategy and save its simulated decisions. No broker calls, no real orders, no real P&L. Reuse requestId on retries; changed inputs require a new ID.",
    inputSchema: z.object({ ...configSchema, requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/) }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
    a => guarded(() => { const run = service.runSample(a); return { id: run.id, status: run.status, mode: run.mode, summary: run.summary }; }));
  server.registerTool("list_runs", { description: "List saved sample runs. History survives server restarts.", inputSchema: z.object({}).strict(), annotations: readOnly },
    () => guarded(() => ({ runs: service.listRuns() })));
  server.registerTool("get_run", { description: "Read a sample run's complete event log, configuration and outcome. These are synthetic, never brokerage trades.",
    inputSchema: z.object({ runId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/) }).strict(), annotations: readOnly }, a => guarded(() => service.getRun(a.runId)));
  server.registerResource("readiness", "trading-agent://readiness", { mimeType: "application/json" },
    () => ({ contents: [{ uri: "trading-agent://readiness", mimeType: "application/json", text: JSON.stringify(service.readiness()) }] }));
  server.registerTool("connect_robinhood", { description: "Start user-approved browser OAuth authorization for Robinhood market data. Returns a Robinhood URL; the user must review and approve access in a desktop browser on the server's machine. Never ask for passwords, tokens or codes in chat. No orders are enabled.",
    inputSchema: z.object({}).strict(), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } }, async () => {
      try { return reply(await service.broker.begin()); }
      catch { return { ...reply({ error: "Unable to start broker authorization. Check connectivity and try again." }), isError: true }; }
    });
  server.registerTool("get_broker_status", { description: "Check browser-authorization progress and verified read capabilities. No account numbers or tokens are returned.",
    inputSchema: z.object({}).strict(), annotations: readOnly }, () => reply(service.broker.status()));
  server.registerTool("get_market_quotes", { description: "Read equity prices from the independently authorized Robinhood connection. Includes timestamps and freshness flags; old quotes must not be described as current. Does not read accounts or place orders.",
    inputSchema: z.object({ symbols: configSchema.symbols }).strict(), annotations: { ...readOnly, openWorldHint: true } }, async a => {
      try { return reply({ quotes: await service.market.quotes(a.symbols), ordersSubmitted: 0 }); }
      catch { return { ...reply({ error: "Market quotes unavailable or invalid. Check broker status; no orders were submitted." }), isError: true }; }
    });
  return server;
}
