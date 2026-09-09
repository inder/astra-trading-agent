import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { RobinhoodConnection, ROBINHOOD_MCP_URL, robinhoodFetch, SessionOAuthProvider, type BrokerToolClient } from "../src/broker-connection.ts";
import { normalizeMarketQuotes, RobinhoodMarketData } from "../src/market-data.ts";

const metadata = { issuer: ROBINHOOD_MCP_URL, authorization_endpoint: "https://robinhood.com/oauth",
  token_endpoint: "https://api.robinhood.com/oauth2/token/", registration_endpoint: "https://agent.robinhood.com/oauth/trading/register",
  response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], scopes_supported: ["internal"] };
const row = (now: number) => ({ quote: { symbol: "DEMOA", state: "active", has_traded: true, last_trade_price: "100",
  venue_last_trade_time: new Date(now).toISOString(), last_non_reg_trade_price: "99", venue_last_non_reg_trade_time: new Date(now - 60000).toISOString(),
  bid_price: "99.99", ask_price: "100.01", venue_bid_time: new Date(now).toISOString(), venue_ask_time: new Date(now).toISOString() } });
function fixture(options: { ttlMs?: number; listing?: { name: string }[] } = {}) {
  let redirect = "", tokenRequests = 0, verifier = "", closed = 0;
  const calls: string[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("oauth-protected-resource")) return Response.json({ resource: ROBINHOOD_MCP_URL, authorization_servers: [ROBINHOOD_MCP_URL], scopes_supported: ["internal"] });
    if (url.includes("oauth-authorization-server")) return Response.json(metadata);
    if (url.endsWith("/register")) {
      const client = JSON.parse(init!.body as string); redirect = client.redirect_uris[0];
      assert.equal(client.token_endpoint_auth_method, "none");
      return Response.json({ ...client, client_id: "test-public-client" }, { status: 201 });
    }
    if (url.endsWith("/token/")) {
      tokenRequests++; const form = new URLSearchParams(init!.body as string);
      assert.equal(form.get("redirect_uri"), redirect); assert.equal(form.get("code"), "test-code");
      verifier = form.get("code_verifier")!; assert.ok(verifier.length >= 43);
      return Response.json({ access_token: "test-access-secret", refresh_token: "test-refresh-secret", token_type: "Bearer", expires_in: 3600 });
    }
    throw new Error("Unexpected fake endpoint");
  };
  const client: BrokerToolClient = {
    listTools: async () => ({ tools: options.listing ?? [{ name: "get_equity_quotes" }, { name: "place_option_order" }] }),
    callTool: async ({ name }) => { calls.push(name); return { structuredContent: { data: { results: [row(Date.now())] } } }; },
    close: async () => { closed++; },
  };
  const connection = new RobinhoodConnection({
    authorize: (provider, args) => auth(provider, { ...args, fetchFn: robinhoodFetch(fakeFetch) }),
    connect: async provider => { assert.equal(provider.tokens()?.access_token, "test-access-secret"); return client; },
    ttlMs: options.ttlMs ?? 60000,
  });
  return { connection, calls, redirect: () => redirect, tokenRequests: () => tokenRequests, verifier: () => verifier, closed: () => closed };
}
function callback(authorizationUrl: string, redirect: string, stateOverride?: string) {
  const url = new URL(redirect);
  url.searchParams.set("code", "test-code");
  url.searchParams.set("state", stateOverride ?? new URL(authorizationUrl).searchParams.get("state")!);
  return url;
}

test("SDK OAuth discovery, registration and PKCE complete without disk credentials; mutations stay blocked", async t => {
  const f = fixture(); t.after(() => f.connection.close());
  const begun = await f.connection.begin() as any;
  assert.equal(begun.state, "awaiting_authorization");
  const url = new URL(begun.authorizationUrl);
  assert.equal(url.origin, "https://robinhood.com"); assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal((await fetch(callback(begun.authorizationUrl, f.redirect(), "wrong-state"))).status, 403);
  assert.equal(f.tokenRequests(), 0);
  assert.equal((await fetch(callback(begun.authorizationUrl, f.redirect()))).status, 200);
  assert.equal(createHash("sha256").update(f.verifier()).digest("base64url"), url.searchParams.get("code_challenge"));
  assert.equal(f.connection.status().state, "connected");
  assert.equal(f.connection.status().orderSubmissionEnabled, false);
  assert.ok(!JSON.stringify(f.connection.status()).includes("test-access-secret"));
  const market = new RobinhoodMarketData(f.connection);
  assert.equal((await market.quotes(["DEMOA"]))[0]!.fresh, true);
  await assert.rejects(f.connection.read("place_option_order" as any, {}), /blocked/);
  assert.deepEqual(f.calls, ["get_equity_quotes"]);
  await f.connection.close(); assert.equal(f.closed(), 1);
  await assert.rejects(market.quotes(["DEMOA"]), /Connect/);
});
test("concurrent begin calls share one authorization flow; declined login cannot exchange a code", async t => {
  const f = fixture(); t.after(() => f.connection.close());
  const [a, b] = await Promise.all([f.connection.begin(), f.connection.begin()]) as any[];
  assert.equal(a.authorizationUrl, b.authorizationUrl);
  const url = callback(a.authorizationUrl, f.redirect()); url.searchParams.set("error", "access_denied");
  assert.equal((await fetch(url)).status, 400); assert.equal(f.tokenRequests(), 0);
  assert.equal(f.connection.status().state, "failed");
});
test("authorization expiry closes callback and leaves no connected credentials", async t => {
  const f = fixture({ ttlMs: 30 }); t.after(() => f.connection.close());
  await f.connection.begin();
  await new Promise(ok => setTimeout(ok, 60));
  assert.equal(f.connection.status().state, "not_connected"); assert.equal(f.tokenRequests(), 0);
});
test("missing required provider tools fails closed after authorization", async t => {
  const f = fixture({ listing: [{ name: "place_option_order" }] }); t.after(() => f.connection.close());
  const begun = await f.connection.begin() as any;
  assert.equal((await fetch(callback(begun.authorizationUrl, f.redirect()))).status, 400);
  assert.equal(f.connection.status().state, "failed"); assert.equal(f.closed(), 1);
});
test("fetch restrictions reject SSRF destinations and credential forwarding", async () => {
  let contacted = 0;
  const restricted = robinhoodFetch(async (_url, options) => { contacted++; assert.equal(options?.redirect, "error"); return new Response("{}"); });
  await assert.rejects(restricted("http://127.0.0.1/secrets"));
  await assert.rejects(restricted("https://agent.robinhood.com.evil.invalid/mcp/trading"));
  await assert.rejects(restricted("https://api.robinhood.com/oauth2/token/", { headers: { authorization: "Bearer test" } }));
  assert.equal(contacted, 0);
  await restricted(ROBINHOOD_MCP_URL); assert.equal(contacted, 1);
});
test("authorization redirects cannot replace the trusted destination, state, or PKCE", () => {
  const p = new SessionOAuthProvider("http://127.0.0.1:1234/callback");
  assert.throws(() => p.redirectToAuthorization(new URL("https://attacker.invalid/oauth")));
  assert.throws(() => p.redirectToAuthorization(new URL("https://robinhood.com/oauth?state=wrong")));
  assert.equal(p.acceptsState("wrong"), false); assert.equal(p.acceptsState(p.state()), true);
  p.finishInteractive(); assert.equal(p.acceptsState(p.state()), false);
});
test("market quotes preserve clocks, reject foreign identities and mark stale/future/unavailable prices", () => {
  const now = Date.now(); const raw = { data: { results: [row(now)] } };
  assert.equal(normalizeMarketQuotes(raw, ["DEMOA"], now)[0]!.fresh, true);
  assert.equal(normalizeMarketQuotes(raw, ["DEMOA"], now + 6000)[0]!.fresh, false);
  assert.equal(normalizeMarketQuotes(raw, ["DEMOA"], now - 1)[0]!.fresh, false);
  assert.throws(() => normalizeMarketQuotes(raw, ["OTHER"], now));
  assert.throws(() => normalizeMarketQuotes(raw, ["DEMOA", "DEMOA"], now));
  const nonregular = structuredClone(raw);
  nonregular.data.results[0]!.quote.venue_last_non_reg_trade_time = new Date(now + 1000).toISOString();
  const q = normalizeMarketQuotes(nonregular, ["DEMOA"], now + 1000)[0]!;
  assert.equal(q.price, 99); assert.equal(q.regularSession, false);
  raw.data.results[0]!.quote.has_traded = false;
  assert.equal(normalizeMarketQuotes(raw, ["DEMOA"], now)[0]!.price, null);
});
