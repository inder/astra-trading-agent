// Serves written reports on loopback, so a link works wherever the user's chat session happens to be rooted.
//
// The file is still the artifact: it is written to disk first, survives this process, and prints. This only removes
// the delivery problem — a path is readable by a client only inside its own working directory, and that directory
// moves. A URL has no such rule.
//
// It serves exactly one kind of thing: HTML reports this process wrote, by an unguessable name. GET only, no
// cookies, no state, 127.0.0.1 only. It is not a file server: a name it did not mint is not served, so a path
// traversal has nothing to traverse to.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { REPORT_CSP } from "./report.ts";

export class ReportServer {
  #server: Server | undefined;
  #port = 0;
  /** Unguessable name to the file it was written as. Only these are served. */
  #reports = new Map<string, string>();
  #limit: number;
  constructor(limit = 20) { this.#limit = limit; }

  /** Publishes a written report and returns the URL to read it at. Starts the server on first use. */
  async publish(path: string): Promise<string> {
    const port = await this.#listen();
    const name = randomBytes(9).toString("base64url");
    this.#reports.set(name, path);
    // Old reports stop being served rather than accumulating handles for the life of the process.
    while (this.#reports.size > this.#limit) this.#reports.delete(this.#reports.keys().next().value!);
    return `http://127.0.0.1:${port}/r/${name}`;
  }
  get port() { return this.#port; }

  async #listen(): Promise<number> {
    if (this.#server) return this.#port;
    const server = createServer((request, response) => {
      const headers = {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        // The page is self-contained, so nothing needs to be fetched, and nothing may be. This is the page's own
        // policy, not a second one: a browser enforces every policy it is given, so a header stricter than the page
        // would forbid the script the page pins by hash and quietly break the print button. Framing is refused here
        // rather than in the page, because a meta policy cannot say it.
        "content-security-policy": `${REPORT_CSP}; frame-ancestors 'none'`,
        "x-content-type-options": "nosniff",
      };
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const name = url.pathname.startsWith("/r/") ? url.pathname.slice(3) : "";
      const file = this.#reports.get(name);
      // A browser page on another origin must not be able to read a report: no cross-origin request carries an
      // Origin header this accepts, and the Host must be the loopback address this process is listening on.
      const expected = new Set([`127.0.0.1:${this.#port}`, `localhost:${this.#port}`]);
      if (request.method !== "GET" || request.headers.origin !== undefined || !expected.has(request.headers.host ?? "")) {
        response.writeHead(403, headers).end("<p>Not available.</p>"); return;
      }
      if (!file) { response.writeHead(404, headers).end("<p>No such report. Ask Astra for a new one.</p>"); return; }
      // Read before the head is written: `writeHead(200).end(readFileSync(...))` evaluates the header first, so a
      // missing file would leave a 200 already sent and the recovery path unable to answer at all — the request
      // would hang rather than fail.
      let body: Buffer;
      try { body = readFileSync(file); }
      catch { response.writeHead(410, headers).end("<p>That report has been moved or deleted. Ask Astra for a new one.</p>"); return; }
      response.writeHead(200, headers).end(body);
    });
    await new Promise<void>((ok, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", ok); });
    server.unref();
    this.#server = server; this.#port = (server.address() as AddressInfo).port;
    return this.#port;
  }
  async close() {
    const server = this.#server; this.#server = undefined; this.#reports.clear(); this.#port = 0;
    if (server) await new Promise<void>(ok => server.close(() => ok()));
  }
}
