import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ROBINHOOD_MCP_URL, robinhoodFetch, SessionOAuthProvider } from "../src/broker-connection.ts";
import { normalizeMarketQuotes, RobinhoodMarketData } from "../src/market-data.ts";
import { brokerFixture as fixture, callback, row } from "./broker-fixture.ts";

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
test("waiting for approval returns connected as soon as the browser approval lands", async t => {
  const f = fixture(); t.after(() => f.connection.close());
  const begun = await f.connection.begin() as any, started = Date.now();
  const waiting = f.connection.waitForAuthorization(10000);
  assert.equal((await fetch(callback(begun.authorizationUrl, f.redirect()))).status, 200);
  const result = await waiting;
  assert.equal(result.outcome, "connected"); assert.equal(result.state, "connected"); assert.equal(result.authorizationExpiresAt, null);
  assert.ok(Date.now() - started < 5000);
  assert.equal((await f.connection.waitForAuthorization(10000)).outcome, "connected");   // already connected: at once
});
test("waiting stops at its limit while the link is open, and reports when the link expires", async t => {
  const f = fixture(); t.after(() => f.connection.close());
  await f.connection.begin();
  const started = Date.now(), result = await f.connection.waitForAuthorization(300);
  assert.equal(result.outcome, "still_waiting"); assert.equal(result.state, "awaiting_authorization");
  assert.ok(Date.now() - started >= 300 && Date.now() - started < 2000);
  assert.ok(Date.parse(result.authorizationExpiresAt!) > Date.now());
  assert.equal(f.connection.status().authorizationExpiresAt, result.authorizationExpiresAt);
});
test("waiting reports an expired link, a declined approval, and no pending approval, without starting one", async t => {
  const expiring = fixture({ ttlMs: 100 }); t.after(() => expiring.connection.close());
  await expiring.connection.begin();
  assert.equal((await expiring.connection.waitForAuthorization(5000)).outcome, "expired");
  const declined = fixture(); t.after(() => declined.connection.close());
  const begun = await declined.connection.begin() as any, waiting = declined.connection.waitForAuthorization(5000);
  const url = callback(begun.authorizationUrl, declined.redirect()); url.searchParams.set("error", "access_denied");
  await fetch(url);
  assert.equal((await waiting).outcome, "declined_or_failed");
  const idle = fixture(); t.after(() => idle.connection.close());
  const started = Date.now(), result = await idle.connection.waitForAuthorization(10000);
  assert.equal(result.outcome, "no_pending_approval"); assert.equal(result.state, "not_connected");
  assert.ok(Date.now() - started < 1000); assert.equal(idle.redirect(), "");   // no approval flow was begun
});
test("a cancelled wait ends promptly and leaves the approval open", async t => {
  const f = fixture(); t.after(() => f.connection.close());
  await f.connection.begin();
  const controller = new AbortController(), started = Date.now();
  setTimeout(() => controller.abort(), 100);
  const result = await f.connection.waitForAuthorization(10000, controller.signal);
  assert.equal(result.outcome, "still_waiting"); assert.ok(Date.now() - started < 2000);
  assert.equal(f.connection.status().state, "awaiting_authorization");
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
