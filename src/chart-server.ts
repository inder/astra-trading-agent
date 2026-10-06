import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ChartListener, IntradayHistory } from "./live-chart.ts";

/** What the chart page reads. Market data only. */
export interface ChartData {
  daily(symbol: string): Promise<unknown>;
  intraday(symbol: string): Promise<IntradayHistory>;
  subscribe(symbol: string, listener: ChartListener): () => void;
}

const SYMBOL = /^[A-Z][A-Z0-9.-]{0,9}$/;
const asset = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");

/** The page is the same for every symbol (the symbol rides in the query string), so it is built once and its script
 *  is pinned by hash. The chart library is inlined from node_modules rather than fetched: nothing on this page may
 *  load from the network, and `connect-src 'self'` is the only door it has — to this server. */
function buildPage(): { html: string; csp: string } {
  const library = readFileSync(new URL("lightweight-charts.standalone.production.js", import.meta.resolve("lightweight-charts")), "utf8");
  const shared = asset("./chart-aggregate.js").replace(/^export /gm, "");
  const script = `${library}\n;(() => {\n${shared}\n${asset("./chart-client.js")}\n})();`;
  const css = asset("./chart.css");
  const hash = (s: string) => createHash("sha256").update(s).digest("base64");
  // Styles are 'unsafe-inline' with no hash: the chart library inserts <style> elements of its own at run time, and a
  // hash in the list makes browsers ignore 'unsafe-inline' and block them (the browser test catches that). Script, the
  // part that matters, stays pinned to one hash; no data from a response is ever written into a style.
  const csp = [`default-src 'none'`, `script-src 'sha256-${hash(script)}'`, `style-src 'unsafe-inline'`,
    `connect-src 'self'`, `img-src data:`, `base-uri 'none'`, `form-action 'none'`].join("; ");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><link rel="icon" href="data:,"><title>Astra chart</title><style>${css}</style></head><body>
<header class="bar">
  <span class="brand">ASTRA<span class="dot">.</span></span>
  <label class="ticker"><span class="sr">Ticker</span><input id="symbol" autocomplete="off" spellcheck="false" maxlength="10" placeholder="Ticker"></label>
  <button type="button" id="go">Chart</button>
  <span id="price" class="price"></span>
  <span id="status" class="status" role="status" aria-live="polite"></span>
</header>
<main>
  <section class="panel" id="daily-panel" aria-label="Daily chart">
    <div class="tools">
      <span class="title">Daily</span>
      <div class="group" id="frames" role="group" aria-label="Timeframe"></div>
      <div class="group zoom" role="group" aria-label="Zoom daily chart">
        <button type="button" data-zoom="in" aria-label="Zoom in">+</button><button type="button" data-zoom="out" aria-label="Zoom out">&minus;</button><button type="button" data-zoom="reset">Reset</button>
      </div>
    </div>
    <div class="chart" id="daily"></div>
    <p class="note" id="daily-note"></p>
  </section>
  <section class="panel" id="intraday-panel" aria-label="Intraday chart">
    <div class="tools">
      <span class="title">Intraday</span>
      <div class="group" id="intervals" role="group" aria-label="Candle size"></div>
      <div class="group zoom" role="group" aria-label="Zoom intraday chart">
        <button type="button" data-zoom="in" aria-label="Zoom in">+</button><button type="button" data-zoom="out" aria-label="Zoom out">&minus;</button><button type="button" data-zoom="reset">Reset</button>
      </div>
    </div>
    <div class="chart" id="intraday"></div>
    <p class="note" id="intraday-note"></p>
  </section>
</main>
<footer>Read-only market data from your Robinhood connection. Advisory: support and resistance describe what the rules found, never what to buy or sell. Charts by <a href="https://www.tradingview.com/" rel="noreferrer">TradingView Lightweight Charts</a>.</footer>
<script>${script}</script></body></html>`;
  return { html, csp };
}

/** Serves the live chart on loopback, under a path that is random for this process.
 *
 *  The same refusals as the report server, for the same reason: another page in the user's browser must not be able
 *  to read their market data through this one. The Host must be the loopback address this listens on; a request
 *  carrying an Origin must carry exactly this server's (a page's own fetches and stream may send it, and send nothing
 *  else); `Sec-Fetch-Site`, when a browser sends it, must say same-origin or a typed-in navigation. */
export class ChartServer {
  #data: ChartData;
  #token = randomBytes(18).toString("base64url");
  #page?: { html: string; csp: string };
  #server?: Server;
  #starting?: Promise<number>;
  #port = 0;
  #streams = new Set<ServerResponse>();
  constructor(data: ChartData) { this.#data = data; }
  /** The page's address for `symbol`. Starts the listener on first use. */
  async url(symbol?: string): Promise<string> {
    if (symbol !== undefined && !SYMBOL.test(symbol)) throw new Error("Invalid ticker");
    const port = await (this.#starting ??= this.#listen().catch(error => { this.#starting = undefined; throw error; }));
    return `http://127.0.0.1:${port}/chart/${this.#token}${symbol ? `?symbol=${symbol}` : ""}`;
  }
  #listen(): Promise<number> {
    // Any failure inside a request answers that request; nothing a local process sends may reach the process's
    // unhandled-rejection handler, which would take down the MCP server and any paper run with it.
    const server = createServer((request, response) => {
      this.#handle(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(400, { "content-type": "text/plain" }).end("Bad request.");
        else response.destroy();
      });
    });
    return new Promise((ok, fail) => {
      server.once("error", fail);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", fail);
        // After binding, a server error retires this listener rather than crashing the process; the next url()
        // call binds a fresh one.
        server.on("error", () => { if (this.#server === server) { this.#server = undefined; this.#starting = undefined; } server.close(); });
        this.#server = server; this.#port = (server.address() as AddressInfo).port; ok(this.#port);
      });
    });
  }
  #allowed(request: IncomingMessage): boolean {
    const own = `http://127.0.0.1:${this.#port}`;
    const hosts = new Set([`127.0.0.1:${this.#port}`, `localhost:${this.#port}`]);
    const origin = request.headers.origin, site = request.headers["sec-fetch-site"];
    return request.method === "GET" && hosts.has(request.headers.host ?? "") &&
      (origin === undefined || origin === own || origin === `http://localhost:${this.#port}`) &&
      (site === undefined || site === "same-origin" || site === "none");
  }
  #tokenMatches(candidate: string) {
    const a = Buffer.from(candidate), b = Buffer.from(this.#token);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  async #handle(request: IncomingMessage, response: ServerResponse) {
    const base = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };
    const json = (status: number, body: unknown) => response.writeHead(status, { ...base, "content-type": "application/json; charset=utf-8" })
      .end(JSON.stringify(body));
    if (!this.#allowed(request)) { json(403, { error: "Not available." }); return; }
    let url: URL;
    try { url = new URL(request.url ?? "/", "http://127.0.0.1"); } catch { json(400, { error: "Bad request." }); return; }
    const [, root, token, ...rest] = url.pathname.split("/");
    if (root !== "chart" || !token || !this.#tokenMatches(token)) { json(404, { error: "No such chart. Ask Astra for a new link." }); return; }
    const route = rest.join("/");
    if (route === "") {
      this.#page ??= buildPage();
      response.writeHead(200, { ...base, "content-type": "text/html; charset=utf-8",
        "content-security-policy": `${this.#page.csp}; frame-ancestors 'none'` }).end(this.#page.html);
      return;
    }
    const symbol = url.searchParams.get("symbol") ?? "";
    if (!SYMBOL.test(symbol)) { json(400, { error: "Invalid ticker." }); return; }
    try {
      if (route === "api/daily") { json(200, await this.#data.daily(symbol)); return; }
      if (route === "api/intraday") { json(200, await this.#data.intraday(symbol)); return; }
      if (route === "api/stream") { this.#stream(symbol, request, response, base); return; }
    } catch (error) {
      json(502, { error: error instanceof Error ? error.message : "Request failed" }); return;
    }
    json(404, { error: "Not found." });
  }
  #stream(symbol: string, request: IncomingMessage, response: ServerResponse, base: Record<string, string>) {
    let unsubscribe: (() => void) | undefined;
    const send = (event: unknown) => { if (!response.writableEnded) response.write(`data: ${JSON.stringify(event)}\n\n`); };
    // Head first: subscribing sends the current status straight away, and a write before the head would go out
    // under default headers, without the event-stream type.
    response.writeHead(200, { ...base, "content-type": "text/event-stream", connection: "keep-alive" });
    response.write("retry: 3000\n\n");
    try { unsubscribe = this.#data.subscribe(symbol, send); }
    catch (error) {
      // `final`: the page must not reconnect, or EventSource would retry this refusal every few seconds.
      send({ type: "error", final: true, message: error instanceof Error ? error.message : "Live prices unavailable" });
      response.end(); return;
    }
    this.#streams.add(response);
    // A comment every 15 s keeps idle proxies and the browser from deciding the stream is dead.
    const beat = setInterval(() => { if (!response.writableEnded) response.write(": keep-alive\n\n"); }, 15000);
    beat.unref();
    const done = () => { clearInterval(beat); unsubscribe?.(); unsubscribe = undefined; this.#streams.delete(response); };
    request.once("close", done); response.once("close", done);
  }
  async close() {
    for (const stream of this.#streams) stream.end();
    this.#streams.clear();
    // A bind still in flight is waited for, so a listener that finishes binding after close() is closed too.
    await this.#starting?.catch(() => undefined);
    const server = this.#server; this.#server = undefined; this.#starting = undefined;
    if (server) await new Promise<void>(ok => { server.closeAllConnections(); server.close(() => ok()); });
  }
}
