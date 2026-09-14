// Drives every Astra MCP tool through a simulated trading day, for the README's Quick start samples.
// Invented prices, an injected clock and a fake Robinhood login: no network, no brokerage, nothing real.
//   node scripts/quickstart-session.ts > /tmp/quickstart.json
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { TradingAgentService } from "../src/agent-service.ts";
import { createAgentMcpServer } from "../src/agent-mcp.ts";
import { RobinhoodConnection, ROBINHOOD_MCP_URL, robinhoodFetch, MARKET_READS, type BrokerToolClient } from "../src/broker-connection.ts";
import { sessionTimes } from "../src/orb-paper-runtime.ts";
import type { PaperMarket } from "../src/paper-market.ts";

const DATE = "2026-09-15", EXPIRY = "2026-09-18";
const { open } = sessionTimes(DATE);
const at = (hhmmss: string) => Date.parse(`${DATE}T${hhmmss}-04:00`);
let now = at("08:30:00");
const iso = (ms: number) => new Date(ms).toISOString();

// Invented prices. Opening ranges (first two minutes): CRWV 90.20-91.80, HPE 60.10-61.00, SMCI 39.60-40.30.
const priorClose: Record<string, number> = { CRWV: 89.40, HPE: 60.20, SMCI: 39.70 };
const premarket: Record<string, number> = { CRWV: 90.85, HPE: 60.55, SMCI: 39.95 };
const price: Record<string, number> = { CRWV: 90.60, HPE: 60.40, SMCI: 39.80 };
const bars: Record<string, [number, number, number, number][]> = {   // open, high, low, close per minute
  CRWV: [[90.60, 91.40, 90.20, 91.10], [91.10, 91.80, 90.90, 91.50]],
  HPE: [[60.40, 61.00, 60.10, 60.70], [60.70, 60.95, 60.30, 60.50]],
  SMCI: [[39.80, 40.30, 39.60, 40.10], [40.10, 40.25, 39.85, 40.00]],
};
const known = new Set(Object.keys(price));
const recheck: Record<string, number> = {};   // the entry's own quote, as a later trade, when set
const optionAsk = (symbol: string, strike: number) => {
  const base: Record<string, number> = { CRWV: 92, HPE: 61, SMCI: 40.5 };
  return Math.max(0.2, Math.round((2.15 + (base[symbol]! - strike) * 0.52) * 100) / 100);
};
let crwvBoost = 0;   // added to the held CRWV call's bid and ask as the stock runs
const strikesFor = (symbol: string) => symbol === "CRWV" ? [89, 90, 91, 92, 93, 94, 95] : symbol === "HPE" ? [59, 60, 61, 62, 63] : [38.5, 39.5, 40.5, 41.5];
const contractId = (symbol: string, strike: number) => {
  const n = [...known].indexOf(symbol) * 100 + Math.round(strike * 2);
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
};
const contracts = (symbol: string) => strikesFor(symbol).map(strike => ({ id: contractId(symbol, strike), symbol, expiration: EXPIRY, strike, multiplier: 100 as const,
  tickBelow: .01, tickAbove: .05, tickCutoff: 3, selloutAt: `${EXPIRY}T19:30:00Z` }));
const byId = new Map([...known].flatMap(s => contracts(s).map(k => [k.id, k] as const)));

const market: PaperMarket = {
  async quotes(requested) {
    if (requested.length === 1 && recheck[requested[0]!] !== undefined) {   // the entry re-reads one stock: a slightly later trade
      now += 400; const p = recheck[requested[0]!]!; delete recheck[requested[0]!];
      return [{ symbol: requested[0]!, price: p, tradeAt: iso(now), retrievedAt: iso(now), ageMs: 0, fresh: true, regularSession: true, state: "active", bid: null, ask: null }];
    }
    return requested.map(symbol => ({ symbol, price: price[symbol]!, tradeAt: iso(now), retrievedAt: iso(now), ageMs: 0, fresh: true,
      regularSession: now >= open, state: "active", bid: null, ask: null }));
  },
  async bars(requested, start, end) {
    return { data: { results: requested.map(symbol => ({ symbol, interval: "minute", bounds: "regular",
      bars: Array.from({ length: (end - start) / 60000 }, (_, i) => { const [o, h, l, c] = bars[symbol]![i]!;
        return { begins_at: iso(start + i * 60000), open_price: String(o), high_price: String(h), low_price: String(l), close_price: String(c), volume: "250000", session: "reg" }; }) })) } };
  },
  async contracts(symbol) { return { expiration: EXPIRY, contracts: contracts(symbol) }; },
  async optionQuotes(ids) {
    return ids.map(id => { const k = byId.get(id)!; let ask = optionAsk(k.symbol, k.strike);
      if (k.symbol === "CRWV" && k.strike === 92) ask = Math.round((ask + crwvBoost) * 100) / 100;
      return { id, bid: Math.round((ask - 0.08) * 100) / 100, ask, askSize: 40, updatedAt: iso(now), retrievedAt: iso(now) }; });
  },
};

// A fake Robinhood login (same shape as the test fixture): OAuth endpoints and the provider client are local fakes.
const metadata = { issuer: ROBINHOOD_MCP_URL, authorization_endpoint: "https://robinhood.com/oauth", token_endpoint: "https://api.robinhood.com/oauth2/token/",
  registration_endpoint: "https://agent.robinhood.com/oauth/trading/register", response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], scopes_supported: ["internal"] };
function fakeBroker() {
  let redirect = "";
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("oauth-protected-resource")) return Response.json({ resource: ROBINHOOD_MCP_URL, authorization_servers: [ROBINHOOD_MCP_URL], scopes_supported: ["internal"] });
    if (url.includes("oauth-authorization-server")) return Response.json(metadata);
    if (url.endsWith("/register")) { const c = JSON.parse(init!.body as string); redirect = c.redirect_uris[0]; return Response.json({ ...c, client_id: "sample-client" }, { status: 201 }); }
    if (url.endsWith("/token/")) return Response.json({ access_token: "sample-access", refresh_token: "sample-refresh", token_type: "Bearer", expires_in: 3600 });
    throw new Error("unexpected endpoint");
  };
  const client: BrokerToolClient = {
    listTools: async () => ({ tools: MARKET_READS.map(name => ({ name })) }),
    callTool: async ({ name, arguments: args }) => {
      if (name !== "get_equity_quotes") throw new Error("not in this sample");
      const symbols = (args as { symbols: string[] }).symbols;
      return { structuredContent: { data: { results: symbols.map(symbol => ({ quote: { symbol, state: "active", has_traded: true,
        last_trade_price: String(priorClose[symbol]), venue_last_trade_time: iso(at("16:00:00") - 86400000 + 0),
        last_non_reg_trade_price: String(premarket[symbol]), venue_last_non_reg_trade_time: iso(now - 30000),
        bid_price: String(premarket[symbol]! - 0.03), ask_price: String(premarket[symbol]! + 0.03), venue_bid_time: iso(now - 5000), venue_ask_time: iso(now - 5000) } })) } } };
    },
    close: async () => {},
  };
  const connection = new RobinhoodConnection({ authorize: (provider, a) => auth(provider, { ...a, fetchFn: robinhoodFetch(fakeFetch) }), connect: async () => client, ttlMs: 600000 });
  return { connection, redirect: () => redirect };
}
const approveInBrowser = async (authorizationUrl: string, redirect: string) => {   // the user's click on Robinhood's page
  const url = new URL(redirect); url.searchParams.set("code", "sample-code"); url.searchParams.set("state", new URL(authorizationUrl).searchParams.get("state")!);
  await fetch(url);
};
const symbolsSource = {
  quotes: async (s: string[]) => { if (s.some(x => !known.has(x))) throw new Error("unknown symbol");
    return s.map(symbol => ({ symbol, price: premarket[symbol]!, tradeAt: iso(now - 30000), retrievedAt: iso(now), ageMs: 30000, fresh: true, regularSession: false, state: "active", bid: null, ask: null })); },
  listedExpirations: async (s: string) => { if (!known.has(s)) throw new Error("unknown symbol"); return ["2026-09-16", EXPIRY, "2026-09-25", "2026-10-16"]; },
};

const dir = mkdtempSync(join(tmpdir(), "astra-quickstart-"));
const out: { step: string; tool: string; args: unknown; clock: string; result: unknown }[] = [];
async function session() {
  const broker = fakeBroker();
  const service = new TradingAgentService(dir, undefined, broker.connection, { market, symbols: symbolsSource, clock: () => now, auto: false });
  const [c, s] = InMemoryTransport.createLinkedPair();
  const server = createAgentMcpServer(service), client = new Client({ name: "quickstart", version: "1" });
  await server.connect(s); await client.connect(c);
  const call = async (step: string, tool: string, args: Record<string, unknown> = {}) => {
    const r: any = await client.callTool({ name: tool, arguments: args });
    const result = JSON.parse(r.content[0].text); out.push({ step, tool, args, clock: new Date(now).toLocaleTimeString("en-US", { timeZone: "America/New_York" }), result });
    return result;
  };
  return { service, broker, client, server, call, close: async () => { await client.close(); await server.close(); await service.close(); } };
}
const tickUntil = async (service: TradingAgentService, runId: string, until: number, every = 2000, onTick?: () => void) => {
  for (; now < until; now += every) { onTick?.(); await service.paper.tick(runId); }
};

const a = await session();
const runId = "orb-2026-09-15";
await a.call("intro", "get_readiness");
await a.call("strategies", "list_strategies");
await a.call("preview", "preview_strategy", { strategyId: "opening-range-options", symbols: ["DEMOA", "DEMOB", "DEMOC"] });
await a.call("practice", "run_sample", { strategyId: "opening-range-options", symbols: ["DEMOA", "DEMOB", "DEMOC"], requestId: "practice-1" });
await a.call("practice-detail", "get_run", { runId: "practice-1" });
const link = await a.call("connect", "connect_robinhood");
const waiting = a.call("connect-wait", "wait_for_robinhood", { seconds: 20 });
await new Promise(r => setTimeout(r, 300)); await approveInBrowser(link.authorizationUrl, a.broker.redirect());
await waiting;
await a.call("broker-status", "get_broker_status");
await a.call("check", "check_symbols", { symbols: ["CRWV", "HPE", "SMCI", "CRVW"] });
await a.call("quotes", "get_market_quotes", { symbols: ["CRWV", "HPE", "SMCI"] });
await a.call("plan", "configure_paper_strategy", { runId, strategyId: "opening-range-options", date: DATE, symbols: ["CRWV", "HPE", "SMCI"], includePremarket: false,
  maxPremiumPerTradeDollars: 1000, maxPremiumPerDayDollars: 2000 });
await a.call("plan-readiness", "get_readiness");
now = at("08:45:00");
await a.call("start", "start_paper_run", { runId });

// The open: ranges form, HPE dips under its low, CRWV's first breakout reverses on the entry's own quote, the second enters.
now = at("09:29:00");
await tickUntil(a.service, runId, at("09:33:08"));
price.HPE = 60.05; price.SMCI = 40.05;
await tickUntil(a.service, runId, at("09:33:40"), 2000, () => { if (now >= at("09:33:10") && price.CRWV! < 91.9) { price.CRWV = 91.95; recheck.CRWV = 91.70; } });
price.CRWV = 91.60; price.HPE = 60.40;
await tickUntil(a.service, runId, at("09:34:20"));
price.CRWV = 92.10;
await tickUntil(a.service, runId, at("09:36:00"));
await a.call("positions", "get_paper_run", { runId });
await a.call("journal", "get_paper_events", { runId, after: -1, limit: 100 });
// CRWV runs; the option doubles and the first target sells half.
price.CRWV = 93.40; crwvBoost = 1.4;
await tickUntil(a.service, runId, at("10:05:00"));
price.CRWV = 94.20; crwvBoost = 2.25;
await tickUntil(a.service, runId, at("10:15:00"));
await a.call("pnl", "get_daily_pnl", { date: DATE });
await a.call("positions-2", "get_paper_run", { runId });
// A trim, approved by the user in the browser.
const trim = await a.call("trim", "propose_position_change", { runId, symbol: "CRWV", action: "trim", percent: 25 });
const approve = async (reviewUrl: string) => {   // the user's click on Astra's local review page
  const get = await fetch(reviewUrl), page = await get.text(); const csrf = page.match(/name="csrf" value="([^"]+)"/)![1]!;
  await fetch(reviewUrl, { method: "POST", headers: { origin: new URL(reviewUrl).origin, "content-type": "application/x-www-form-urlencoded",
    cookie: get.headers.get("set-cookie")!.split(";")[0]! }, body: new URLSearchParams({ csrf, decision: "approve" }).toString() });
};
await a.call("trim-pending", "get_position_review", { reviewId: trim.reviewId });
await approve(trim.reviewUrl);
await a.call("trim-done", "get_position_review", { reviewId: trim.reviewId });
await tickUntil(a.service, runId, at("10:30:00"));
// Stop, then a restart: a new process, a fresh Robinhood approval, and recovery of the open position only.
await a.call("stop", "stop_paper_run", { runId });
await a.close();
now = at("10:41:00");
const b = await session();
await b.call("after-restart", "list_paper_runs");
const link2 = await b.call("reconnect", "connect_robinhood");
const waiting2 = b.call("reconnect-wait", "wait_for_robinhood", { seconds: 20 });
await new Promise(r => setTimeout(r, 300)); await approveInBrowser(link2.authorizationUrl, b.broker.redirect());
await waiting2;
await b.call("resume", "resume_paper_run", { runId });
await tickUntil(b.service, runId, at("10:44:00"));
await b.call("resumed", "get_paper_run", { runId });
const closeAll = await b.call("close", "propose_position_change", { runId, symbol: "CRWV", action: "close" });
await approve(closeAll.reviewUrl);
await b.call("close-done", "get_position_review", { reviewId: closeAll.reviewId });
await tickUntil(b.service, runId, at("10:46:00"));
await b.call("pnl-2", "get_daily_pnl", { date: DATE });
// Tomorrow's plan with the user's own rules: one stock, $500, entries until 10:30, two tries per breakout.
await b.call("tomorrow", "configure_paper_strategy", { runId: "orb-2026-09-16", strategyId: "opening-range-options", date: "2026-09-16", symbols: ["CRWV", "SMCI"],
  includePremarket: false, maximumPositions: 1, maxPremiumPerTradeDollars: 500, maxPremiumPerDayDollars: 500, entryWindowMinutes: 60, maxEntryAttempts: 2 });
await b.call("paper-runs", "list_paper_runs");
await b.call("history", "list_runs");
await b.call("end-readiness", "get_readiness");
await b.close();
rmSync(dir, { recursive: true, force: true });
console.log(JSON.stringify(out, null, 1));
process.exit(0);
