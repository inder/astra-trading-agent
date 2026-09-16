import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { VERSION } from "./version.ts";

export const ROBINHOOD_MCP_URL = "https://agent.robinhood.com/mcp/trading";
export const MARKET_READS = Object.freeze(["get_equity_quotes", "get_equity_technical_indicators", "get_equity_historicals", "get_option_chains", "get_option_instruments", "get_option_quotes"] as const);
export type MarketRead = typeof MARKET_READS[number];
/** Account reads live in their own list, with their own accessor, deliberately. Robinhood's single `internal` scope
 *  grants 73 tools including order placement, so these two arrays are the whole boundary — and keeping them apart
 *  means a change that widens market data cannot widen account access by accident, and any diff that touches what
 *  Astra can see of an account is visibly a diff to ACCOUNT_READS. */
export const ACCOUNT_READS = Object.freeze(["get_accounts", "get_portfolio", "get_equity_positions"] as const);
export type AccountRead = typeof ACCOUNT_READS[number];
/** Only a read may appear in either list. The positive rule is the one that matters: a name outside the provider's
 *  read convention is refused, so `submit_order` or `transfer_funds` cannot be added however they are spelled. The
 *  denylist stays as a second pass for a name that reads like a getter but is not. */
const READ_NAME = /^(get|list)_/;
const FORBIDDEN = /(order|transfer|withdraw|deposit|liquidat|execut|submit|buy|sell|cancel|exercise|place)/;
for (const tool of [...MARKET_READS, ...ACCOUNT_READS]) {
  if (!READ_NAME.test(tool)) throw new Error(`Refusing a tool outside the read naming convention: ${tool}`);
  if (FORBIDDEN.test(tool)) throw new Error(`Refusing a tool that names a mutation: ${tool}`);
}
if (MARKET_READS.some(t => (ACCOUNT_READS as readonly string[]).includes(t))) throw new Error("Read allowlists must not overlap");
const allowedURLs = new Set([
  ROBINHOOD_MCP_URL,
  "https://agent.robinhood.com/.well-known/oauth-protected-resource/mcp/trading",
  "https://agent.robinhood.com/.well-known/oauth-protected-resource",
  "https://agent.robinhood.com/.well-known/oauth-authorization-server/mcp/trading",
  "https://agent.robinhood.com/.well-known/oauth-authorization-server",
  "https://agent.robinhood.com/mcp/trading/.well-known/openid-configuration",
  "https://agent.robinhood.com/.well-known/openid-configuration/mcp/trading",
  "https://agent.robinhood.com/oauth/trading/register",
  "https://api.robinhood.com/oauth2/token/",
]);

/** Pin both discovery and token destinations. Never follow credentials through redirects. */
export function robinhoodFetch(base: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!allowedURLs.has(url.href)) throw new Error("Unapproved Robinhood endpoint");
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (headers.has("authorization") && url.href !== ROBINHOOD_MCP_URL) throw new Error("Credential destination rejected");
    const upstream = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    return base(input, { ...init, redirect: "error", signal: upstream ? AbortSignal.any([upstream, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000) });
  };
}

export class SessionOAuthProvider implements OAuthClientProvider {
  readonly redirectUrl: string;
  #state = randomBytes(32).toString("base64url");
  #client: OAuthClientInformationMixed | undefined;
  #tokens: OAuthTokens | undefined;
  #verifier: string | undefined;
  #authorizationUrl: string | undefined;
  #interactive = true;
  constructor(redirectUrl: string) { this.redirectUrl = redirectUrl; }
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: "Astra Trading Agent for Robinhood", redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
  }
  state() { return this.#state; }
  acceptsState(state: string | null) {
    if (!state || !this.#interactive) return false;
    const a = Buffer.from(state), b = Buffer.from(this.#state);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  clientInformation() { return this.#client; }
  saveClientInformation(info: OAuthClientInformationMixed) { this.#client = info; }
  tokens() { return this.#tokens; }
  saveTokens(tokens: OAuthTokens) { this.#tokens = tokens; }
  saveCodeVerifier(verifier: string) {
    if (!this.#interactive) throw new Error("New browser authorization required");
    this.#verifier = verifier;
  }
  codeVerifier() { if (!this.#verifier) throw new Error("Missing PKCE verifier"); return this.#verifier; }
  redirectToAuthorization(url: URL) {
    if (!this.#interactive || url.origin !== "https://robinhood.com" || url.pathname !== "/oauth" ||
      url.searchParams.get("state") !== this.#state || url.searchParams.get("code_challenge_method") !== "S256" ||
      !url.searchParams.get("code_challenge") || url.searchParams.get("redirect_uri") !== this.redirectUrl)
      throw new Error("Authorization destination or PKCE validation failed");
    this.#authorizationUrl = url.href;
  }
  authorizationUrl() { return this.#authorizationUrl; }
  finishInteractive() { this.#interactive = false; this.#verifier = undefined; this.#authorizationUrl = undefined; }
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if (scope === "all" || scope === "tokens") this.#tokens = undefined;
    if (scope === "all" || scope === "client") this.#client = undefined;
    if (scope === "all" || scope === "verifier") this.#verifier = undefined;
  }
}

export interface BrokerToolClient {
  listTools(): Promise<{ tools: { name: string }[]; nextCursor?: string }>;
  callTool(args: { name: string; arguments: Record<string, unknown> }): Promise<any>;
  close(): Promise<void>;
}
export interface ConnectionDependencies {
  authorize: typeof auth;
  connect: (provider: SessionOAuthProvider) => Promise<BrokerToolClient>;
  ttlMs: number;
}
const network = robinhoodFetch();
const defaults: ConnectionDependencies = {
  authorize: (provider, options) => auth(provider, { ...options, fetchFn: network }),
  connect: async provider => {
    const client = new Client({ name: "astra-market-data", version: VERSION });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(ROBINHOOD_MCP_URL), { authProvider: provider, fetch: network }));
      return client;
    } catch { await client.close(); throw new Error("Robinhood handshake failed"); }
  },
  ttlMs: 600000,
};

export class RobinhoodConnection {
  #deps: ConnectionDependencies;
  #state: "not_connected" | "preparing" | "awaiting_authorization" | "verifying" | "connected" | "failed" = "not_connected";
  #provider: SessionOAuthProvider | undefined;
  #callback: Server | undefined;
  #timer: NodeJS.Timeout | undefined;
  #client: BrokerToolClient | undefined;
  #expiresAt: number | undefined;
  #generation = 0;
  #tools = new Set<string>();
  #lastVerifiedAt: string | null = null;
  #lastAccountReadAt: string | null = null;
  /** Identifies one connected session. A reconnect may be a different Robinhood login, so anything a caller derived
   *  from the old connection — account handles, above all — can be dropped when this changes. */
  #connectionId: string | null = null;
  #beginning: Promise<unknown> | undefined;
  constructor(deps: Partial<ConnectionDependencies> = {}) { this.#deps = { ...defaults, ...deps }; }
  status() {
    return { state: this.#state, orderSubmissionEnabled: false, credentialStorage: "memory_only",
      connectionId: this.#connectionId,
      lastMarketReadAt: this.#lastVerifiedAt,
      lastAccountReadAt: this.#lastAccountReadAt,
      // Account reads are an optional capability: market data must still connect when the provider does not grant
      // them. Listing accounts needs only its own tool, so a partial grant still answers "which accounts are there".
      accountListAvailable: this.#state === "connected" && this.#tools.has("get_accounts"),
      accountToolsAvailable: this.#state === "connected" && ACCOUNT_READS.every(t => this.#tools.has(t)),
      quoteToolAvailable: this.#state === "connected" && this.#tools.has("get_equity_quotes"),
      movingAverageToolAvailable: this.#state === "connected" && this.#tools.has("get_equity_technical_indicators"),
      paperDataAvailable: this.#state === "connected" && MARKET_READS.filter(t => t !== "get_equity_technical_indicators").every(t => this.#tools.has(t)),
      authorizationExpiresAt: this.#state === "awaiting_authorization" && this.#expiresAt ? new Date(this.#expiresAt).toISOString() : null,
      note: "Robinhood authorizes broader access than this adapter uses. Astra allows market-data reads, and reads of your accounts when you ask about them. It never places, changes or cancels an order. Restart requires authorization again." };
  }
  /** Wait up to ms for a pending browser approval to settle. Never starts one; the checks are in memory only. */
  async waitForAuthorization(ms: number, signal?: AbortSignal) {
    const pending = () => this.#state === "preparing" || this.#state === "awaiting_authorization" || this.#state === "verifying";
    const wasPending = pending(), deadline = Date.now() + ms;
    while (pending() && !signal?.aborted && Date.now() < deadline) await new Promise(ok => setTimeout(ok, Math.min(250, deadline - Date.now())));
    const state = this.#state;
    // A pending approval that ends not connected was closed by its expiry timer (or a shutdown), not declined.
    const outcome = state === "connected" ? "connected" : pending() ? "still_waiting" : state === "failed" ? "declined_or_failed" : wasPending ? "expired" : "no_pending_approval";
    return { outcome, state, authorizationExpiresAt: this.status().authorizationExpiresAt };
  }
  begin(): Promise<unknown> {
    if (this.#beginning) return this.#beginning;
    this.#beginning = this.#begin().finally(() => { this.#beginning = undefined; });
    return this.#beginning;
  }
  async #begin() {
    if (this.#state === "connected") return { ...this.status(), authorizationUrl: null };
    if (this.#state === "awaiting_authorization") return { ...this.status(), authorizationUrl: this.#provider?.authorizationUrl(), expiresAt: this.#expiresAt };
    if (["preparing", "verifying"].includes(this.#state)) return { ...this.status(), authorizationUrl: null };
    await this.close(); const generation = this.#generation; this.#state = "preparing";
    const callback = createServer(async (req, res) => {
      res.setHeader("Cache-Control", "no-store"); res.setHeader("Referrer-Policy", "no-referrer"); res.setHeader("Content-Type", "text/plain");
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method !== "GET" || req.headers.origin !== undefined || req.headers.host !== `127.0.0.1:${(callback.address() as AddressInfo | null)?.port}` || url.pathname !== "/callback") {
        res.writeHead(403).end("Invalid callback"); return;
      }
      const provider = this.#provider;
      if (this.#state !== "awaiting_authorization" || !provider || !provider.acceptsState(url.searchParams.get("state")) ||
        url.searchParams.getAll("state").length !== 1 || Date.now() > this.#expiresAt!) {
        res.writeHead(403).end("Invalid or expired authorization"); return;
      }
      if (url.searchParams.has("error")) { this.#state = "failed"; this.#stopCallback(); res.writeHead(400).end("Authorization declined. Return to your agent."); return; }
      const code = url.searchParams.get("code");
      if (!code || code.length > 4096 || url.searchParams.getAll("code").length !== 1) { res.writeHead(400).end("Missing authorization code"); return; }
      this.#state = "verifying"; // consume callback before awaiting network calls
      let candidate: BrokerToolClient | undefined;
      try {
        const outcome = await this.#deps.authorize(provider, { serverUrl: ROBINHOOD_MCP_URL, authorizationCode: code });
        if (generation !== this.#generation) throw new Error("Connection cancelled");
        if (outcome !== "AUTHORIZED" || !provider.tokens()) throw new Error("Authorization incomplete");
        provider.finishInteractive();
        candidate = await this.#deps.connect(provider);
        if (generation !== this.#generation) throw new Error("Connection cancelled");
        const listing = await candidate.listTools();
        // Do not infer capabilities from an incomplete tool list.
        if (listing.nextCursor || !listing.tools.some(t => t.name === "get_equity_quotes")) {
          throw new Error("Market-data tools unavailable");
        }
        if (generation !== this.#generation) throw new Error("Connection cancelled");
        this.#client = candidate; candidate = undefined; this.#tools = new Set(listing.tools.map(t => t.name));
        this.#state = "connected"; this.#connectionId = randomBytes(9).toString("base64url");
        // Said at the moment of consent, so it states what this grant actually permits, not what the build can do.
        this.#stopCallback();
        res.end(`Connected for market data${this.#tools.has("get_accounts") ? ", and for listing your accounts when you ask" : ""}. Return to your agent. Real orders are disabled.`);
      } catch {
        await candidate?.close().catch(() => {}); provider.invalidateCredentials("all");
        if (generation === this.#generation) { this.#state = "failed"; this.#stopCallback(); }
        res.writeHead(400).end("Connection could not be verified. Return to your agent and retry. No orders were submitted.");
      }
    });
    this.#callback = callback;
    try {
      await new Promise<void>((ok, fail) => { callback.once("error", fail); callback.listen(0, "127.0.0.1", ok); });
      const port = (callback.address() as AddressInfo).port;
      this.#provider = new SessionOAuthProvider(`http://127.0.0.1:${port}/callback`);
      this.#expiresAt = Date.now() + this.#deps.ttlMs;
      this.#timer = setTimeout(() => { void this.close(); }, this.#deps.ttlMs); this.#timer.unref();
      const outcome = await this.#deps.authorize(this.#provider, { serverUrl: ROBINHOOD_MCP_URL, scope: "internal" });
      if (generation !== this.#generation || outcome !== "REDIRECT" || !this.#provider?.authorizationUrl()) throw new Error("Authorization URL unavailable");
      this.#state = "awaiting_authorization";
      return { ...this.status(), authorizationUrl: this.#provider.authorizationUrl(), expiresAt: this.#expiresAt,
        instruction: "Open this link in a desktop browser on the machine running Astra. Review Robinhood's requested access. Never paste passwords or codes into chat." };
    } catch {
      if (generation === this.#generation) { this.#state = "failed"; this.#provider?.invalidateCredentials("all"); this.#stopCallback(); }
      throw new Error("Could not begin Robinhood authorization. Check network access and retry.");
    }
  }
  #stopCallback() { if (this.#timer) clearTimeout(this.#timer); this.#timer = undefined; this.#callback?.close(); this.#callback = undefined; }
  async close() {
    this.#generation++; this.#stopCallback(); this.#provider?.invalidateCredentials("all"); this.#provider = undefined;
    const client = this.#client; this.#client = undefined; this.#tools.clear(); this.#state = "not_connected";
    // Both timestamps reset together: a stale account time would outlive the connection that earned it.
    this.#lastVerifiedAt = null; this.#lastAccountReadAt = null; this.#connectionId = null;
    await client?.close();
  }
  async read(tool: MarketRead, args: Record<string, unknown>): Promise<unknown> {
    // Runtime allowlist, not just a TypeScript annotation.
    if (!(MARKET_READS as readonly string[]).includes(tool)) throw new Error("Broker mutation or unsupported tool blocked");
    const payload = await this.#call(tool, args, "Robinhood market-data read failed; check connection status. No order was submitted.");
    this.#lastVerifiedAt = new Date().toISOString();
    return payload;
  }
  /** An account read. Separate from `read` so the two allowlists can never be confused for one another, and so status
   *  reports account access separately from market access. The error text is fixed: an account payload or an account
   *  number must never reach the chat through an error message. */
  async accountRead(tool: AccountRead, args: Record<string, unknown>): Promise<unknown> {
    if (!(ACCOUNT_READS as readonly string[]).includes(tool)) throw new Error("Broker mutation or unsupported tool blocked");
    const payload = await this.#call(tool, args, "Robinhood account read failed; check connection status. No order was submitted.");
    this.#lastAccountReadAt = new Date().toISOString();
    return payload;
  }
  async #call(tool: string, args: Record<string, unknown>, failure: string): Promise<any> {
    if (this.#state !== "connected" || !this.#client || !this.#tools.has(tool)) throw new Error("Connect Robinhood market data first");
    try {
      const result = await this.#client.callTool({ name: tool, arguments: args });
      if (result.isError) throw new Error("Read failed");
      const payload = result.structuredContent ?? JSON.parse(result.content?.find((c: any) => c.type === "text")?.text ?? "null");
      if (!payload || !payload.data) throw new Error("Invalid provider response");
      return payload;
    } catch { throw new Error(failure); }
  }
}
