import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TradingAgentService, type SymbolLevels } from "../src/agent-service.ts";
import { createAgentMcpServer } from "../src/agent-mcp.ts";
import type { RobinhoodConnection } from "../src/broker-connection.ts";
import type { DailyBars } from "../src/levels.ts";
import { syntheticBars } from "./levels-fixture.ts";

const bars = syntheticBars();
const barPayload = (symbol: string, series: DailyBars) => ({ data: { results: [{ symbol, interval: "day", bounds: "regular",
  bars: series.time.map((t, i) => ({ begins_at: `${t}T13:30:00Z`, open_price: String(series.open[i]), high_price: String(series.high[i]),
    low_price: String(series.low[i]), close_price: String(series.close[i]), volume: "1000", session: "reg" })) }] } });
const quotePayload = (symbols: string[], price: number, tradeAt: number) => ({ data: { results: symbols.map(symbol => ({ quote: {
  symbol, state: "active", has_traded: true, last_trade_price: String(price), venue_last_trade_time: new Date(tradeAt).toISOString(),
  last_non_reg_trade_price: String(price), venue_last_non_reg_trade_time: new Date(tradeAt - 3600000).toISOString(),
  bid_price: String(price - 0.01), ask_price: String(price + 0.01), venue_bid_time: new Date(tradeAt).toISOString(),
  venue_ask_time: new Date(tradeAt).toISOString() } })) } });

function fixture(t: { after: (fn: () => unknown) => void }, options: { quoteAt?: number; barsFail?: boolean; ready?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "astra-levels-"));
  const reads: string[] = [];
  const broker = { read: async (tool: string, args: Record<string, unknown>) => {
      reads.push(`${tool}:${(args.symbols as string[]).join(",")}`);
      if (tool === "get_equity_quotes") return quotePayload(args.symbols as string[], 131.5, options.quoteAt ?? Date.now() - 1000);
      if (tool === "get_equity_historicals") {
        if (options.barsFail) throw new Error("test-only outage");
        return barPayload((args.symbols as string[])[0]!, bars);
      }
      throw new Error("unexpected tool");
    }, status: () => ({ state: options.ready === false ? "disconnected" : "connected" }), close: async () => {} } as unknown as RobinhoodConnection;
  const service = new TradingAgentService(directory, undefined, broker, { ready: () => options.ready !== false, clock: () => Date.parse("2026-09-10T12:00:00Z"), auto: false });
  t.after(async () => { await service.close(); rmSync(directory, { recursive: true, force: true }); });
  return { service, reads };
}
const usable = (l: SymbolLevels) => { assert.ok(!("unavailable" in l), `${l.symbol} unavailable`); return l as Exclude<SymbolLevels, { unavailable: string }>; };

test("levels come from daily bars and a live quote, and each stock's bars are read once a day", async t => {
  const f = fixture(t);
  const [first] = await f.service.levels(["FIXA"]);
  const got = usable(first!);
  assert.equal(got.symbol, "FIXA");
  assert.equal(got.priceSource, "quote"); assert.equal(got.price, 131.5);
  assert.equal(got.defaultTimeframe, "2y");
  const frame = got.frames.find(x => x.timeframe === "2y")!;
  assert.ok(frame.support!.length && frame.resistance!.length, "both sides have zones");
  assert.ok(frame.support!.every(z => z.hi < got.price) && frame.resistance!.every(z => z.lo > got.price));
  assert.deepEqual(got.averages.map(a => a.period), [10, 21, 50, 200]);
  assert.deepEqual(f.reads, ["get_equity_quotes:FIXA", "get_equity_historicals:FIXA"]);
  await f.service.levels(["FIXA"]);
  assert.deepEqual(f.reads.filter(r => r.startsWith("get_equity_historicals")).length, 1, "the day's bars are reused");
  assert.equal(f.reads.filter(r => r.startsWith("get_equity_quotes")).length, 2, "the price is not");
});
test("a stale quote falls back to the last close, and says so", async t => {
  const f = fixture(t, { quoteAt: Date.now() - 600000 });
  const got = usable((await f.service.levels(["FIXA"]))[0]!);
  assert.equal(got.priceSource, "close"); assert.equal(got.price, bars.close.at(-1));
});
test("a stock whose history cannot be read is named, and the others still answer", async t => {
  const f = fixture(t, { barsFail: true });
  const [only] = await f.service.levels(["FIXA"]);
  assert.deepEqual(only, { symbol: "FIXA", unavailable: "daily price history could not be read" });
});
test("levels need the market-data connection, and refuse bad ticker lists", async t => {
  const f = fixture(t, { ready: false });
  await assert.rejects(f.service.levels(["FIXA"]), /Connect Robinhood market data first/);
  const g = fixture(t);
  await assert.rejects(g.service.levels(["not a ticker"]), /Invalid ticker list/);
  await assert.rejects(g.service.levels([]), /Invalid ticker list/);
});

async function overMcp(t: { after: (fn: () => unknown) => void }, options: Parameters<typeof fixture>[1] = {}) {
  const f = fixture(t, options);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createAgentMcpServer(f.service), client = new Client({ name: "levels-test", version: "1" });
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverSide); await client.connect(clientSide);
  return { client, call: (args: Record<string, unknown>) =>
    client.callTool({ name: "get_levels", arguments: args }) as Promise<{ isError?: boolean; content: { text: string }[] }> };
}
test("get_levels reads market data only, answers as advice, and never submits an order", async t => {
  const m = await overMcp(t);
  const tool = (await m.client.listTools()).tools.find(x => x.name === "get_levels")!;
  assert.equal(tool.annotations?.readOnlyHint, true);
  assert.match(tool.description!, /never what to buy or sell/);
  const body = JSON.parse((await m.call({ symbols: ["FIXA"], timeframe: "ytd" })).content[0]!.text);
  assert.equal(body.advisory, true); assert.equal(body.ordersSubmitted, 0);
  assert.equal(body.levels[0].symbol, "FIXA"); assert.equal(body.levels[0].requested, "ytd");
  assert.ok(!("next" in body), "an answer is not a setup step");
  // The window asked for is shown, and the others stay available for a follow-up question.
  assert.deepEqual(body.levels[0].frames.map((x: any) => x.timeframe), ["qtd", "ytd", "2y"]);
});
test("get_levels refuses unknown timeframes and leads a disconnected user to the next step", async t => {
  const m = await overMcp(t);
  const refused = async (args: Record<string, unknown>, expected: RegExp) => {
    const r = await m.call(args);
    assert.equal(r.isError, true); assert.match(r.content[0]!.text, expected);
  };
  await refused({ symbols: ["FIXA"], timeframe: "5y" }, /timeframe/i);
  await refused({ symbols: ["FIXA"], adjustment: "split" }, /adjustment/i);   // no unknown knobs, so a wrong one is never silently ignored
  const off = await overMcp(t, { ready: false });
  const failed = await off.call({ symbols: ["FIXA"] });
  assert.equal(failed.isError, true);
  const body = JSON.parse(failed.content[0]!.text);
  assert.match(body.error, /Connect Robinhood market data first/);
  assert.equal(body.next.next.tool, "connect_robinhood");
});
