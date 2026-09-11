import assert from "node:assert/strict";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { RobinhoodConnection, ROBINHOOD_MCP_URL, robinhoodFetch, type BrokerToolClient } from "../src/broker-connection.ts";

// A real RobinhoodConnection whose OAuth endpoints and provider client are fakes: no network, invented tokens.
const metadata = { issuer: ROBINHOOD_MCP_URL, authorization_endpoint: "https://robinhood.com/oauth",
  token_endpoint: "https://api.robinhood.com/oauth2/token/", registration_endpoint: "https://agent.robinhood.com/oauth/trading/register",
  response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], scopes_supported: ["internal"] };
export const row = (now: number) => ({ quote: { symbol: "DEMOA", state: "active", has_traded: true, last_trade_price: "100",
  venue_last_trade_time: new Date(now).toISOString(), last_non_reg_trade_price: "99", venue_last_non_reg_trade_time: new Date(now - 60000).toISOString(),
  bid_price: "99.99", ask_price: "100.01", venue_bid_time: new Date(now).toISOString(), venue_ask_time: new Date(now).toISOString() } });
export function brokerFixture(options: { ttlMs?: number; listing?: { name: string }[] } = {}) {
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
/** The browser's return to Astra's loopback callback after the user approves (or, with a wrong state, a forgery). */
export function callback(authorizationUrl: string, redirect: string, stateOverride?: string) {
  const url = new URL(redirect);
  url.searchParams.set("code", "test-code");
  url.searchParams.set("state", stateOverride ?? new URL(authorizationUrl).searchParams.get("state")!);
  return url;
}
