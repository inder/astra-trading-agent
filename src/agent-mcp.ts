import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TradingAgentService } from "./agent-service.ts";
import { SUPPORTED_YEARS } from "./daily-history.ts";
import { ENTRY_WINDOW_MINUTES, SETTINGS } from "./orb-options.ts";

export function createAgentMcpServer(service: TradingAgentService): McpServer {
  const server = new McpServer({ name: "astra-trading-agent", title: "Astra Trading Agent for Robinhood", version: "0.3.0" });
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
  const asyncGuarded = async (action: () => Promise<unknown>) => {
    try { return reply(await action()); }
    catch (error) { return guarded(() => { throw error; }); }
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
  const runId = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
  const runSchema = z.object({ runId }).strict();
  const years = `${SUPPORTED_YEARS[0]}–${SUPPORTED_YEARS.at(-1)}`;
  const date = z.string().regex(new RegExp(`^(${SUPPORTED_YEARS.join("|")})-\\d{2}-\\d{2}$`));
  const paperWrite = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
  // Human units at the chat edge (whole dollars, whole numbers); parseOrbOptionsConfig re-validates in internal units.
  const dollars = (r: { min: number; max: number }) => z.number().int().min(r.min / 100).max(r.max / 100).optional();
  const whole = (r: { min: number; max: number }) => z.number().int().min(r.min).max(r.max).optional();
  server.registerTool("configure_paper_strategy", { description: `Save immutable settings for a continuous PAPER strategy. Does not start it or need brokerage credentials. A new configuration needs a new runId. Calendar supports ${years}.`,
    inputSchema: z.object({ ...configSchema, runId, date,
      entryWindowMinutes: z.number().int().min(ENTRY_WINDOW_MINUTES.min).max(ENTRY_WINDOW_MINUTES.max).optional()
        .describe(`Minutes after the 9:30 ET open during which new entries may start; default ${ENTRY_WINDOW_MINUTES.default} (11:00 ET). Open positions are managed all day.`),
      maxPremiumPerTradeDollars: dollars(SETTINGS.budgetCentsPerPosition).describe(`Most premium one trade may commit, treated as money that can be lost entirely; default $${SETTINGS.budgetCentsPerPosition.default / 100}.`),
      maxPremiumPerDayDollars: dollars(SETTINGS.budgetCentsPerDay).describe(`Most premium committed per day across trades (sales never refund it); default $${SETTINGS.budgetCentsPerDay.default / 100}.`),
      minimumContracts: whole(SETTINGS.minimumContracts).describe(`Fewest contracts per entry; the strike nearest the money that fits this many is chosen, then filled to the cap. Default ${SETTINGS.minimumContracts.default}.`),
      maximumContractsPerTrade: whole(SETTINGS.maximumContractsPerTrade).describe("Optional ceiling on contracts per entry; by default only the displayed ask size limits the fill."),
      maximumPositions: whole(SETTINGS.maximumPositions).describe(`Most stocks entered per day; default ${SETTINGS.maximumPositions.default}.`),
      maxOptionSpreadPercent: z.number().int().min(SETTINGS.maxOptionSpreadFraction.min * 100).max(SETTINGS.maxOptionSpreadFraction.max * 100).optional()
        .describe(`Widest bid-ask spread accepted, as a percent of the midpoint; default ${SETTINGS.maxOptionSpreadFraction.default * 100}.`),
      feeReservePerContractCents: whole(SETTINGS.feeReserveCentsPerContract).describe(`Cents reserved per contract for fees inside the cap; default ${SETTINGS.feeReserveCentsPerContract.default}.`),
    }).strict(), annotations: { ...paperWrite, idempotentHint: true } },
    ({ maxPremiumPerTradeDollars, maxPremiumPerDayDollars, maxOptionSpreadPercent, feeReservePerContractCents, ...a }) => guarded(() => service.paper.configure({ ...a,
      budgetCentsPerPosition: maxPremiumPerTradeDollars === undefined ? undefined : maxPremiumPerTradeDollars * 100,
      budgetCentsPerDay: maxPremiumPerDayDollars === undefined ? undefined : maxPremiumPerDayDollars * 100,
      maxOptionSpreadFraction: maxOptionSpreadPercent === undefined ? undefined : maxOptionSpreadPercent / 100,
      feeReserveCentsPerContract: feeReservePerContractCents })));
  server.registerTool("start_paper_run", { description: "Explicitly start the configured PAPER strategy with authorized market data. Start before the opening two-minute candle completes. No real orders; one run per strategy per session prevents budget recycling.",
    inputSchema: runSchema, annotations: paperWrite }, a => asyncGuarded(() => service.paper.start(a.runId)));
  server.registerTool("resume_paper_run", { description: "Explicitly recover EXISTING paper positions after stopping or restarting. No new entries after a monitoring gap. Requires reauthorization after server restart. Does not place real orders.",
    inputSchema: runSchema, annotations: paperWrite }, a => asyncGuarded(() => service.paper.start(a.runId, true)));
  server.registerTool("stop_paper_run", { description: "Stop monitoring a PAPER run. Retains open simulated positions and disables their automated exits. This does NOT close them; use a reviewed position close first if desired.",
    inputSchema: runSchema, annotations: paperWrite }, a => asyncGuarded(() => service.paper.stop(a.runId)));
  server.registerTool("list_paper_runs", { description: "List paper runs and identify detached runs needing explicit recovery.",
    inputSchema: z.object({}).strict(), annotations: readOnly }, () => guarded(() => ({ runs: service.paper.list() })));
  server.registerTool("get_paper_run", { description: "Read PAPER positions, configuration, latest events, committed budget and estimated option P&L. Stale marks are null, not current prices. P&L excludes fees and is not brokerage P&L.",
    inputSchema: runSchema, annotations: readOnly }, a => guarded(() => service.paper.status(a.runId)));
  server.registerTool("get_paper_events", { description: "Read the immutable PAPER decision journal in revision order. Pass the last returned revision as after for the next page.",
    inputSchema: z.object({ runId, after: z.number().int().min(-1).default(-1), limit: z.number().int().min(1).max(100).default(20) }).strict(), annotations: readOnly },
    a => guarded(() => ({ pages: service.paper.events(a.runId, a.after, a.limit) })));
  server.registerTool("get_daily_pnl", { description: "Aggregate this installation's simulated option P&L for a date, not brokerage account performance. Includes feesExcluded and missing-mark indicators.",
    inputSchema: z.object({ date }).strict(), annotations: readOnly }, a => guarded(() => service.paper.daily(a.date)));
  server.registerTool("propose_position_change", { description: "Propose a trim by percentage of current whole contracts, or close all, ONLY for this run's PAPER position. Returns exact rounded quantity and a short-lived local browser review URL. The user approves in the browser; requesting this tool does not execute the sale.",
    inputSchema: z.object({ runId, symbol: z.string().regex(/^[A-Z][A-Z0-9.-]{0,9}$/), action: z.enum(["trim", "close"]), percent: z.number().positive().max(100).optional() }).strict(), annotations: paperWrite },
    a => asyncGuarded(() => service.reviews.propose(a.runId, a.symbol, a.action, a.percent)));
  server.registerTool("get_position_review", { description: "Read approval status of a paper position-change proposal. This tool cannot approve a proposal.",
    inputSchema: z.object({ reviewId: z.string().regex(/^[A-Za-z0-9_-]{32}$/) }).strict(), annotations: readOnly }, a => guarded(() => service.reviews.status(a.reviewId)));
  return server;
}
