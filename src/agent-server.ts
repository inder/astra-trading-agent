#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { TradingAgentService } from "./agent-service.ts";
import { createAgentMcpServer } from "./agent-mcp.ts";

// Loopback-only, single-owner transport. No public listener or OAuth claim.
export function agentHttpServer(service: TradingAgentService, token: string): Server {
  if (token.length < 32 || !/^[\x21-\x7e]+$/.test(token)) throw new Error("HTTP token must contain at least 32 printable, non-space characters");
  const expected = Buffer.from(`Bearer ${token}`);
  return createServer(async (req, res) => {
    const host = req.headers.host ?? "";
    if (!/^127\.0\.0\.1(?::\d+)?$/.test(host) || req.headers.origin !== undefined) { res.writeHead(403).end(); return; }
    const supplied = Buffer.from(req.headers.authorization ?? "");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.writeHead(401).end(); return; }
    if (req.url !== "/mcp") { res.writeHead(404).end(); return; }
    if (req.method !== "POST") { res.writeHead(405, { Allow: "POST" }).end(); return; }
    if (!req.headers["content-type"]?.startsWith("application/json")) { res.writeHead(415).end(); return; }
    let length = 0; const chunks: Buffer[] = [];
    try {
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 65536) { res.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { res.writeHead(400).end(); return; }
      const server = createAgentMcpServer(service);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => { void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch { if (!res.headersSent) res.writeHead(500).end(); }
  });
}

export async function runAgentServer(args = process.argv.slice(2)) {
  let transport = "stdio", port = 8787, dataDirectory = process.env.TRADING_AGENT_DATA_DIR ?? join(homedir(), ".trading-agent");
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help") {
      console.log("astra-trading-agent [--transport stdio|http] [--port 8787] [--data-dir DIRECTORY]\nSamples and continuous PAPER strategies with read-only Robinhood data. HTTP binds 127.0.0.1 and requires TRADING_AGENT_MCP_TOKEN (32+ characters). Startup requires no brokerage or LLM key. No real orders."); return;
    }
    if (!["--transport", "--port", "--data-dir"].includes(arg!) || !args[i + 1] || args[i + 1]!.startsWith("--")) throw new Error("Invalid server arguments; use --help");
    const value = args[++i]!;
    if (arg === "--transport") transport = value;
    if (arg === "--port") { if (!/^\d+$/.test(value)) throw new Error("Invalid port"); port = Number(value); }
    if (arg === "--data-dir") dataDirectory = resolve(value);
  }
  if (!["stdio", "http"].includes(transport) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid transport or port");
  const service = new TradingAgentService(dataDirectory);
  const closeService = () => service.close().catch(() => {
    console.error("Astra stopped, but final paper state could not be saved. Inspect run history before recovery."); process.exitCode = 1;
  });
  if (transport === "stdio") {
    const server = createAgentMcpServer(service);
    await server.connect(new StdioServerTransport());
    server.server.onclose = () => { void closeService(); };
    process.once("SIGTERM", () => { void closeService().finally(() => server.close()); });
    process.once("SIGINT", () => { void closeService().finally(() => server.close()); });
  } else {
    const server = agentHttpServer(service, process.env.TRADING_AGENT_MCP_TOKEN ?? "");
    server.requestTimeout = 10000; server.headersTimeout = 10000;
    await new Promise<void>((ok, fail) => { server.once("error", fail); server.listen(port, "127.0.0.1", ok); });
    console.error("Astra Trading Agent for Robinhood: paper-only MCP listening on loopback. Use --help for connection settings.");
    const stop = () => { server.close(); server.closeIdleConnections(); void closeService(); };
    process.once("SIGTERM", stop); process.once("SIGINT", stop);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runAgentServer().catch(() => { console.error("Trading Agent could not start. Check arguments, data directory and HTTP token; use --help."); process.exitCode = 1; });
}
