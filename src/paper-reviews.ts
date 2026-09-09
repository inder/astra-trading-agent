import { createServer, type Server } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { PaperController } from "./paper-controller.ts";
import type { PaperControl } from "./paper-runtime.ts";

interface Review { id: string; runId: string; command: PaperControl; expiresAt: number; cookie: string; csrf: string;
  status: "pending" | "executing" | "executed" | "rejected"; result?: unknown }
const secret = () => randomBytes(24).toString("base64url");
const equal = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Human review is a separate local browser interaction, never an MCP confirmed=true. */
export class PaperReviews {
  #paper: PaperController; #server?: Server; #starting?: Promise<void>; #reviews = new Map<string, Review>();
  constructor(paper: PaperController) { this.#paper = paper; }
  async #start() {
    if (this.#starting) return this.#starting;
    this.#starting = (async () => {
      const server = createServer(async (req, res) => {
        const port = (server.address() as AddressInfo).port, origin = `http://127.0.0.1:${port}`;
        res.setHeader("Cache-Control", "no-store"); res.setHeader("Referrer-Policy", "no-referrer");
        res.setHeader("X-Frame-Options", "DENY"); res.setHeader("Content-Security-Policy", "default-src 'none'; form-action 'self'; frame-ancestors 'none'");
        if (req.headers.host !== `127.0.0.1:${port}`) { res.writeHead(403).end(); return; }
        const url = new URL(req.url ?? "/", origin), id = url.pathname.slice(1), review = this.#reviews.get(id);
        if (!review || review.expiresAt < Date.now() || review.status !== "pending") { res.writeHead(410).end("Review expired or already used"); return; }
        if (req.method === "GET") {
          if (req.headers.origin && req.headers.origin !== origin) { res.writeHead(403).end(); return; }
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.setHeader("Set-Cookie", `astra_review=${review.cookie}; HttpOnly; SameSite=Strict; Path=/${id}; Max-Age=120`);
          res.end(`<!doctype html><title>Review paper position change</title><h1>Astra Trading Agent for Robinhood</h1><h2>Paper simulation only</h2><p>Run: ${escape(review.runId)}</p><p>${escape(review.command.action)} ${review.command.quantity} call contract(s) on ${escape(review.command.symbol)}. Current quantity must still be ${review.command.expectedQuantity}.</p><p>This does not place a brokerage order. A fresh quote and unchanged position are required. Closing this page cancels nothing and approves nothing.</p><form method="post"><input type="hidden" name="csrf" value="${review.csrf}"><button name="decision" value="approve">Approve simulated sale</button><button name="decision" value="reject">Reject</button></form>`); return;
        }
        if (req.method !== "POST" || req.headers.origin !== origin || !req.headers["content-type"]?.startsWith("application/x-www-form-urlencoded")) { res.writeHead(403).end(); return; }
        let body = "";
        try { for await (const chunk of req) { body += chunk; if (body.length > 4096) throw new Error("Oversized review"); } }
        catch { res.writeHead(413).end(); return; }
        const form = new URLSearchParams(body);
        const cookie = req.headers.cookie?.split("; ").find(c => c.startsWith("astra_review="))?.slice(13) ?? "";
        if (!equal(cookie, review.cookie) || !equal(form.get("csrf") ?? "", review.csrf) || review.expiresAt < Date.now() || review.status !== "pending") { res.writeHead(403).end(); return; }
        if (form.get("decision") !== "approve") { review.status = "rejected"; res.end("Rejected. No position changed."); return; }
        review.status = "executing";
        try { const result = await this.#paper.execute(review.runId, review.command); review.result = result; review.status = result.executed ? "executed" : "rejected"; }
        catch { review.status = "rejected"; review.result = { reason: "position_changed_or_data_unavailable" }; }
        res.end(`Paper request ${review.status}. Return to your agent for status.`);
      });
      this.#server = server;
      server.requestTimeout = 10000; server.headersTimeout = 10000;
      await new Promise<void>((ok, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", ok); });
    })().catch(e => { this.#starting = undefined; this.#server = undefined; throw e; });
    return this.#starting;
  }
  async propose(runId: string, symbol: string, action: "trim" | "close", percent?: number) {
    const record = this.#paper.status(runId), p = record.view.positions.find(p => p.symbol === symbol);
    if (!record.attached || !p) throw new Error("No active paper position");
    if (action === "trim" && (!Number.isFinite(percent) || percent! <= 0 || percent! > 100)) throw new Error("Trim percent must be greater than zero and at most 100");
    if (!["trim", "close"].includes(action) || (action === "close" && percent !== undefined)) throw new Error("Invalid position action");
    for (const [id, r] of this.#reviews) if (r.expiresAt < Date.now()) this.#reviews.delete(id);
    if (this.#reviews.size >= 64) throw new Error("Too many pending reviews");
    const quantity = action === "close" ? p.quantity : Math.min(p.quantity, Math.max(1, Math.round(p.quantity * percent! / 100)));
    await this.#start();
    const id = secret(), review: Review = { id, runId, command: { symbol, quantity, expectedQuantity: p.quantity, action },
      expiresAt: Date.now() + 120000, status: "pending", cookie: secret(), csrf: secret() };
    this.#reviews.set(id, review);
    return { reviewId: id, reviewUrl: `http://127.0.0.1:${(this.#server!.address() as AddressInfo).port}/${id}`,
      command: review.command, expiresAt: review.expiresAt, executed: false, mode: "paper", instruction: "Review and approve in your local browser. No MCP tool can approve this request." };
  }
  status(id: string) { const r = this.#reviews.get(id); if (!r) throw new Error("Unknown review"); return { reviewId: id, status: r.status === "pending" && r.expiresAt < Date.now() ? "expired" : r.status, result: r.result }; }
  async close() { this.#reviews.clear(); const server = this.#server; this.#server = undefined; this.#starting = undefined;
    if (server) { server.closeAllConnections(); await new Promise<void>(ok => server.close(() => ok())); } }
}
