import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TradingAgentService } from "./agent-service.ts";
import { SUPPORTED_YEARS } from "./daily-history.ts";
import { ENTRY_WINDOW_MINUTES, SETTINGS } from "./orb-options.ts";
import { SERVER_INSTRUCTIONS } from "./setup-guide.ts";
import { SYMBOL_PROBLEMS } from "./symbol-check.ts";
import { VERSION } from "./version.ts";

export function createAgentMcpServer(service: TradingAgentService): McpServer {
  const server = new McpServer({ name: "astra-trading-agent", title: "Astra Trading Agent for Robinhood", version: VERSION }, { instructions: SERVER_INSTRUCTIONS });
  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  const reply = (result: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(result) }] });
  // The guided next step rides on setup results too, for clients that don't pass server instructions to their model.
  const next = () => { try { return service.guide(); } catch { return null; } };
  // Whether a reply carries the guided next step. "always" is for setup tools; "on_error" is for tools whose success
  // is an answer rather than a setup step (an advisory reading must not read as a nudge into the paper flow) but
  // whose failure still has to lead somewhere. Three named modes, not a boolean: a truthiness test would silently
  // start attaching the guide to answers.
  type Lead = "always" | "on_error" | "never";
  const guarded = (action: () => unknown, lead: Lead = "never") => {
    try { return reply(lead === "always" ? { ...action() as object, next: next() } : action()); }
    catch (error) {
      // Filesystem errors must not leak paths, machine details or stored contents.
      const code = (error as NodeJS.ErrnoException).code;
      return { ...reply({ error: error instanceof SyntaxError ? "Saved run is unreadable" : code ? (code === "ENOENT" ? "Run not found" : "Run storage unavailable") :
        error instanceof Error ? error.message : "Request failed", ...(lead === "never" ? {} : { next: next() }) }), isError: true };
    }
  };
  const asyncGuarded = async (action: () => Promise<unknown>, lead: Lead = "never") => {
    try { const result = await action(); return guarded(() => result, lead); }
    catch (error) { return guarded(() => { throw error; }, lead); }
  };
  server.registerTool("get_readiness", { description: "Call this first in every conversation, and whenever unsure what to do next. Returns Astra's status and its guide: what to explain to the user, the one question to ask, and the next tool. No credentials required.",
    inputSchema: z.object({}).strict(), annotations: readOnly }, () => reply(service.readiness()));
  server.registerTool("list_strategies", { description: "List versioned strategies supported by this installation, not by other legacy programs.",
    inputSchema: z.object({}).strict(), annotations: readOnly }, () => reply({ strategies: service.catalog(), next: next() }));
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
      try { return reply({ ...await service.broker.begin() as object, next: next() }); }
      catch { return { ...reply({ error: "Unable to start broker authorization. Check connectivity and try again.", next: next() }), isError: true }; }
    });
  server.registerTool("wait_for_robinhood", { description: "After sharing the connect_robinhood link, wait here for the user's browser approval instead of asking them to say they are done. Returns an outcome (connected, still_waiting, expired, declined_or_failed or no_pending_approval) and the next step. Waits at most 40 seconds per call; call again while still_waiting. Never starts an approval or accepts credentials.",
    inputSchema: z.object({ seconds: z.number().int().min(1).max(40).default(30).describe("How long to wait this call; 40 at most, to stay inside chat apps' tool time limits.") }).strict(),
    annotations: readOnly }, async (a, extra) => reply({ ...await service.broker.waitForAuthorization(a.seconds * 1000, extra.signal), next: next() }));
  server.registerTool("get_broker_status", { description: "Check browser-authorization progress and verified read capabilities. No account numbers or tokens are returned.",
    inputSchema: z.object({}).strict(), annotations: readOnly }, () => reply({ ...service.broker.status(), next: next() }));
  server.registerTool("check_symbols", { description: "Check tickers the user proposes before saving a paper plan: each one's latest Robinhood price and whether it lists the week-ending call expiry Astra's entry rule needs for the next session. Read-only: one quote batch and one option-chain read per ticker. Strikes and option prices are judged at entry, not here.",
    inputSchema: z.object({ symbols: configSchema.symbols }).strict(), annotations: { ...readOnly, openWorldHint: true } },
    a => asyncGuarded(async () => ({ ...await service.checkSymbols(a.symbols), problems: SYMBOL_PROBLEMS }), "always"));
  server.registerTool("get_levels", { description: "Support and resistance for stocks, computed from Robinhood price history: price zones with how often they were tested, open gaps, trend lines and moving averages. Daily bars cover the quarter, the year and two years; ask for the \"5y\" timeframe and it measures five years of WEEKLY bars instead, for the long view. Reads market data only, never an account. Advisory: it describes what the rules found, never what to buy or sell.",
    inputSchema: z.object({ symbols: configSchema.symbols,
      timeframe: z.enum(["qtd", "ytd", "2y", "5y"]).optional()
        .describe("Which window to lead with; the daily ones are returned too. Defaults to the longest daily window with enough history. \"5y\" is five years of WEEKLY bars, included only when asked for: its zones, ATR and trend lines are weekly, so never describe them as daily levels.") }).strict(),
    annotations: { ...readOnly, openWorldHint: true } },
    a => asyncGuarded(async () => ({ levels: await service.levels(a.symbols, a.timeframe), advisory: true, ordersSubmitted: 0 }), "on_error"));
  server.registerTool("list_accounts", { description: "List the user's Robinhood accounts so they can choose which to report on. Returns an opaque handle for each and a label masked to the last four digits; the full account number is never returned. Reads account names and status only — no balances, no positions, no orders. Show the labels and ask which accounts the user wants before reading any of them.",
    inputSchema: z.object({}).strict(), annotations: { ...readOnly, openWorldHint: true } },
    () => asyncGuarded(async () => ({ accounts: await service.accounts(), ordersSubmitted: 0 })));
  server.registerTool("get_portfolio_report", { description: "Build a portfolio report for the chosen accounts: cost basis, profit and loss, and the support and resistance around each holding, with an expandable chart per stock. Call list_accounts first and ask the user which accounts to include — this reads their balances and positions. Returns a localhost URL to open, the file it was written to, and an overview. Give the user the URL as a link, then summarize the overview in two or three sentences — the detail belongs in the report, not in chat. Reads market data and the chosen accounts; places no orders. Advisory: it reports what the rules found, never what to buy or sell.",
    inputSchema: z.object({
      accounts: z.array(z.string().regex(/^acct_[0-9a-f]{12}$/)).min(1).max(20)
        .describe("Handles from list_accounts. There is no \"all\" shortcut: name each account the user chose."),
    }).strict(), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } },
    a => asyncGuarded(async () => ({ ...await service.portfolioReport(a.accounts), advisory: true, ordersSubmitted: 0 })));
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
  const multiple = (r: { min: number; max: number }) => z.number().min(r.min).max(r.max).optional();
  const percent = (r: { min: number; max: number }) => z.number().min(r.min * 100).max(r.max * 100).optional();
  // Percent to fraction without float noise in the pinned config (0.7% -> 0.007, not 0.006999999999999999).
  const fraction = (p: number | undefined) => p === undefined ? undefined : Math.round(p * 1e6) / 1e8;
  const seconds = (r: { min: number; max: number }) => z.number().min(r.min / 1000).max(r.max / 1000).optional();
  const ms = (s: number | undefined) => s === undefined ? undefined : Math.round(s * 1000);
  server.registerTool("configure_paper_strategy", { description: `Save immutable settings for a continuous PAPER strategy. Does not start it or need brokerage credentials. A new configuration needs a new runId. Calendar supports ${years}.`,
    inputSchema: z.object({ ...configSchema, runId, date,
      entryWindowMinutes: z.number().int().min(ENTRY_WINDOW_MINUTES.min).max(ENTRY_WINDOW_MINUTES.max).optional()
        .describe(`Minutes after the 9:30 ET open during which new entries may start; default ${ENTRY_WINDOW_MINUTES.default} (11:00 ET). Open positions are managed all day.`),
      maxPremiumPerTradeDollars: dollars(SETTINGS.budgetCentsPerPosition).describe(`Most premium one trade may commit, treated as money that can be lost entirely; default $${SETTINGS.budgetCentsPerPosition.default / 100}.`),
      maxPremiumPerDayDollars: dollars(SETTINGS.budgetCentsPerDay).describe(`Most premium committed per day across trades (sales never refund it); default $${SETTINGS.budgetCentsPerDay.default / 100}.`),
      minimumContracts: whole(SETTINGS.minimumContracts).describe(`Fewest contracts per entry; the strike nearest the money that fits this many is chosen, then filled to the cap. Default ${SETTINGS.minimumContracts.default}.`),
      maximumContractsPerTrade: whole(SETTINGS.maximumContractsPerTrade).describe("Optional ceiling on contracts per entry; by default only the displayed ask size limits the fill."),
      maximumPositions: whole(SETTINGS.maximumPositions).describe(`Most stocks entered per day; default ${SETTINGS.maximumPositions.default}.`),
      maxOptionSpreadPercent: z.number().min(SETTINGS.maxOptionSpreadFraction.min * 100).max(SETTINGS.maxOptionSpreadFraction.max * 100).optional()
        .describe(`Widest bid-ask spread accepted, as a percent of the midpoint; default ${SETTINGS.maxOptionSpreadFraction.default * 100}.`),
      feeReserveCentsPerContract: whole(SETTINGS.feeReserveCentsPerContract).describe(`Cents reserved per contract for fees inside the cap; default ${SETTINGS.feeReserveCentsPerContract.default}.`),
      firstTargetMultiple: multiple(SETTINGS.firstTargetMultiple).describe(`Option bid as a multiple of entry at which half the contracts (rounded up) sell; default ${SETTINGS.firstTargetMultiple.default}x.`),
      middleTargetMultiple: multiple(SETTINGS.middleTargetMultiple).describe(`Multiple for contracts between the first half and the last one; default ${SETTINGS.middleTargetMultiple.default}x.`),
      finalTargetMultiple: multiple(SETTINGS.finalTargetMultiple).describe(`Multiple for the last contract; default ${SETTINGS.finalTargetMultiple.default}x.`),
      backstopPercent: percent(SETTINGS.backstopFraction).describe(`Robinhood safety stop as a percent of the entry premium; default ${SETTINGS.backstopFraction.default * 100}.`),
      stopBufferPercent: percent(SETTINGS.stopBufferFraction).describe(`How far below the opening-range low the stock stop sits, in percent; default ${SETTINGS.stopBufferFraction.default * 100}.`),
      flattenLeadMinutes: whole(SETTINGS.flattenLeadMinutes).describe(`Minutes before the close when everything still held sells and new entries stop; default ${SETTINGS.flattenLeadMinutes.default} (3:59 pm ET).`),
      pollSeconds: seconds(SETTINGS.pollMs).describe(`Seconds between market-data polls; default ${SETTINGS.pollMs.default / 1000}.`),
      maxQuoteAgeSeconds: seconds(SETTINGS.maxQuoteAgeMs).describe(`Oldest a stock or option quote may be when fetched and still be acted on; default ${SETTINGS.maxQuoteAgeMs.default / 1000}; at least one poll.`),
      maxObservationGapSeconds: seconds(SETTINGS.maxObservationGapMs).describe(`Longest gap between observations before a watched stock is dropped for the day, so an unseen price path is never assumed; default ${SETTINGS.maxObservationGapMs.default / 1000}; at least two polls.`),
      rangeDeadlineSeconds: seconds(SETTINGS.rangeDeadlineMs).describe(`How long after 9:32 ET to keep retrying the opening-range bars before skipping a stock; default ${SETTINGS.rangeDeadlineMs.default / 1000}.`),
      maxEntryQuoteBatches: whole(SETTINGS.maxEntryQuoteBatches).describe(`Most batches of 20 nearest strikes quoted at an entry before skipping it; default ${SETTINGS.maxEntryQuoteBatches.default}.`),
      maxEntryAttempts: whole(SETTINGS.maxEntryAttempts).describe(`Entry attempts per stock per day. An attempt whose own quote is back at or below the opening high (or is no newer than the breakout trade) uses one attempt and returns the stock to watching for a later breakout while the low holds; default ${SETTINGS.maxEntryAttempts.default}, 1 = the first attempt only.`),
      heartbeatSeconds: seconds(SETTINGS.heartbeatMs).describe(`Seconds between journal heartbeats (latest prices, price range seen, marks, read failures); default ${SETTINGS.heartbeatMs.default / 1000}.`),
      readFailureHaltSeconds: seconds(SETTINGS.readFailureHaltMs).describe(`How long market-data reads may keep failing before the run halts; with positions open only if option prices fail too; default ${SETTINGS.readFailureHaltMs.default / 1000}.`),
    }).strict(), annotations: { ...paperWrite, idempotentHint: true } },
    ({ maxPremiumPerTradeDollars, maxPremiumPerDayDollars, maxOptionSpreadPercent, backstopPercent, stopBufferPercent,
      pollSeconds, maxQuoteAgeSeconds, maxObservationGapSeconds, rangeDeadlineSeconds, readFailureHaltSeconds, heartbeatSeconds, ...a }) => guarded(() => service.paper.configure({ ...a,
      heartbeatMs: ms(heartbeatSeconds),
      pollMs: ms(pollSeconds), maxQuoteAgeMs: ms(maxQuoteAgeSeconds), maxObservationGapMs: ms(maxObservationGapSeconds),
      rangeDeadlineMs: ms(rangeDeadlineSeconds), readFailureHaltMs: ms(readFailureHaltSeconds),
      budgetCentsPerPosition: maxPremiumPerTradeDollars === undefined ? undefined : maxPremiumPerTradeDollars * 100,
      budgetCentsPerDay: maxPremiumPerDayDollars === undefined ? undefined : maxPremiumPerDayDollars * 100,
      maxOptionSpreadFraction: fraction(maxOptionSpreadPercent), backstopFraction: fraction(backstopPercent), stopBufferFraction: fraction(stopBufferPercent) }), "always"));
  server.registerTool("start_paper_run", { description: "Explicitly start the configured PAPER strategy with authorized market data, only after the user says yes to the plan. Start before the opening two-minute candle completes. No real orders; one run per strategy per session prevents budget recycling.",
    inputSchema: runSchema, annotations: paperWrite }, a => asyncGuarded(() => service.paper.start(a.runId), "always"));
  server.registerTool("resume_paper_run", { description: "Explicitly recover EXISTING paper positions after stopping or restarting, only after the user says yes. No new entries after a monitoring gap. Requires reauthorization after server restart. After the session has closed it instead settles a run still holding contracts: they are written off as a total loss (no market data needed). Does not place real orders.",
    inputSchema: runSchema, annotations: paperWrite }, a => asyncGuarded(() => service.paper.start(a.runId, true), "always"));
  server.registerTool("stop_paper_run", { description: "Stop monitoring a PAPER run. Retains open simulated positions and disables their automated exits. This does NOT close them; use a reviewed position close first if desired.",
    inputSchema: runSchema, annotations: paperWrite }, a => asyncGuarded(() => service.paper.stop(a.runId), "always"));
  server.registerTool("list_paper_runs", { description: "List paper runs and identify detached runs needing explicit recovery.",
    inputSchema: z.object({}).strict(), annotations: readOnly }, () => guarded(() => ({ runs: service.paper.list() }), "always"));
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
