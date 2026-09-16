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
import { DailyBarsError, normalizeDailyBars } from "../src/market-data.ts";
import { syntheticBars } from "./levels-fixture.ts";

// The settled history ends Wednesday 9 September 2026. Robinhood also returns the current session while it trades,
// so the fixture appends Thursday the 10th: a bar the service must drop until that session closes.
const bars = syntheticBars();
const forming = { time: "2026-09-10", open: 131.2, high: 133.4, low: 130.9, close: 132.8 };
const withToday = (series: DailyBars): DailyBars => ({ time: [...series.time, forming.time], open: [...series.open, forming.open],
  high: [...series.high, forming.high], low: [...series.low, forming.low], close: [...series.close, forming.close] });
const barPayload = (symbol: string, series: DailyBars) => ({ data: { results: [{ symbol, interval: "day", bounds: "regular",
  bars: series.time.map((t, i) => ({ begins_at: `${t}T13:30:00Z`, open_price: String(series.open[i]), high_price: String(series.high[i]),
    low_price: String(series.low[i]), close_price: String(series.close[i]), volume: "1000", session: "reg" })) }] } });
const quotePayload = (symbols: string[], price: number, tradeAt: number) => ({ data: { results: symbols.map(symbol => ({ quote: {
  symbol, state: "active", has_traded: true, last_trade_price: String(price), venue_last_trade_time: new Date(tradeAt).toISOString(),
  last_non_reg_trade_price: String(price), venue_last_non_reg_trade_time: new Date(tradeAt - 3600000).toISOString(),
  bid_price: String(price - 0.01), ask_price: String(price + 0.01), venue_bid_time: new Date(tradeAt).toISOString(),
  venue_ask_time: new Date(tradeAt).toISOString() } })) } });

function fixture(t: { after: (fn: () => unknown) => void }, options: { quoteAt?: number; barsFail?: boolean | "malformed"; ready?: boolean; now?: number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "astra-levels-"));
  const reads: string[] = [];
  const broker = { read: async (tool: string, args: Record<string, unknown>) => {
      reads.push(`${tool}:${(args.symbols as string[]).join(",")}`);
      if (tool === "get_equity_quotes") return quotePayload(args.symbols as string[], 131.5, options.quoteAt ?? Date.now() - 1000);
      if (tool === "get_equity_historicals") {
        if (options.barsFail === "malformed") return { data: { results: [{ symbol: "FIXA", interval: "day", bars: "not bars" }] } };
        if (options.barsFail) throw new Error("Robinhood market-data read failed; check connection status. No order was submitted.");
        return barPayload((args.symbols as string[])[0]!, withToday(bars));
      }
      throw new Error("unexpected tool");
    }, status: () => ({ state: options.ready === false ? "disconnected" : "connected" }), close: async () => {} } as unknown as RobinhoodConnection;
  const service = new TradingAgentService(directory, undefined, broker,
    { ready: () => options.ready !== false, clock: () => options.now ?? Date.parse("2026-09-10T12:00:00Z"), auto: false });
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
test("the weekly window is answered when it is asked for, and left out when it is not", async t => {
  const f = fixture(t);
  const [plain] = await f.service.levels(["FIXA"]);
  assert.deepEqual(usable(plain!).frames.map(x => x.timeframe), ["qtd", "ytd", "2y"], "a written answer stays daily");
  const [weekly] = await f.service.levels(["FIXA"], "5y");
  const got = usable(weekly!);
  assert.equal(got.requested, "5y");
  const frame = got.frames.find(x => x.timeframe === "5y")!;
  assert.equal(frame.bar, "week");
  assert.ok(frame.sessions > 0 && frame.sessions < got.sessions / 4, "weeks, not sessions");
  assert.equal(got.defaultTimeframe, "2y", "asking for weekly does not make it the default");
  assert.equal(f.reads.filter(r => r.startsWith("get_equity_historicals")).length, 1, "and it needs no second bar read");
  // The clock is Thursday 10 September 2026, 8:00 a.m. ET, so the settled session is Wednesday the 9th and the week
  // of the 7th is still forming. The service must hand that settled date down, or the part-week would be measured.
  const lastWeek = frame.support!.concat(frame.resistance!).flatMap(z => z.members.map(m => m.date)).sort().at(-1)!;
  assert.ok(lastWeek < "2026-09-07", `the forming week is not measured: newest member ${lastWeek}`);
});
test("a stale quote falls back to the last close, and says so", async t => {
  const f = fixture(t, { quoteAt: Date.now() - 600000 });
  const got = usable((await f.service.levels(["FIXA"]))[0]!);
  assert.equal(got.priceSource, "close"); assert.equal(got.price, bars.close.at(-1));
});
test("a stock whose history cannot be read is named, and a broken read is not called a missing history", async t => {
  const f = fixture(t, { barsFail: true });
  const [only] = await f.service.levels(["FIXA"]);
  // The broker's own failure text mentions "no order was submitted"; that must not be read as unusable bars.
  assert.deepEqual(only, { symbol: "FIXA", unavailable: "daily price history could not be read" });
  const g = fixture(t, { barsFail: "malformed" });
  assert.deepEqual((await g.service.levels(["FIXA"]))[0], { symbol: "FIXA", unavailable: "no usable daily price history from Robinhood" });
});
test("levels need the market-data connection, and refuse bad ticker lists", async t => {
  const f = fixture(t, { ready: false });
  await assert.rejects(f.service.levels(["FIXA"]), /Connect Robinhood market data first/);
  const g = fixture(t);
  await assert.rejects(g.service.levels(["not a ticker"]), /Invalid ticker list/);
  await assert.rejects(g.service.levels([]), /Invalid ticker list/);
});

test("bars Robinhood cannot vouch for are refused, never turned into a level", () => {
  const one = (bar: Record<string, unknown>, symbol = "FIXA") => ({ data: { results: [{ symbol, interval: "day", bounds: "regular",
    bars: [{ begins_at: "2026-09-08T13:30:00Z", open_price: "10", high_price: "11", low_price: "9", close_price: "10.5" }, bar] }] } });
  const good = { begins_at: "2026-09-09T13:30:00Z", open_price: "10.5", high_price: "12", low_price: "10", close_price: "11.75" };
  assert.deepEqual(normalizeDailyBars(one(good), "FIXA").close, [10.5, 11.75]);
  const refused: [string, unknown][] = [
    // An interpolated bar is the dangerous one: it looks like a session and nothing downstream can tell it was invented.
    ["Interpolated daily bar", one({ ...good, interpolated: true })],
    ["Duplicate daily bar", one({ ...good, begins_at: "2026-09-08T13:30:00Z" })],
    ["Daily bars are out of order", one({ ...good, begins_at: "2026-09-05T13:30:00Z" })],
    ["Invalid daily bar date", one({ ...good, begins_at: "2026-09-09" })],
    ["Invalid daily bar prices", one({ ...good, high_price: "9" })],
    ["Invalid daily bar prices", one({ ...good, close_price: "0" })],
    ["Invalid daily bar prices", one({ ...good, open_price: "n/a" })],
    ["Daily bars unavailable", one(good, "OTHER")],
    ["Daily bars unavailable", { data: { results: [{ symbol: "FIXA", interval: "5minute", bars: [good] }] } }],
    ["Daily bars unavailable", { data: { results: [] } }],
    ["Daily bars unavailable", { data: {} }],
  ];
  for (const [message, raw] of refused) {
    assert.throws(() => normalizeDailyBars(raw, "FIXA"), (e: Error) => e instanceof DailyBarsError && e.message === message, message);
  }
});
test("a half-formed bar is never measured or cached: today counts only once its session has closed", async t => {
  const duringTheDay = fixture(t, { now: Date.parse("2026-09-10T15:00:00Z") });       // 11:00 a.m. ET, still trading
  const mid = usable((await duringTheDay.service.levels(["FIXA"]))[0]!);
  assert.equal(mid.asOf, "2026-09-09", "today's forming bar is left out");
  const afterTheClose = fixture(t, { now: Date.parse("2026-09-10T20:30:00Z") });      // 4:30 p.m. ET, the session is final
  const done = usable((await afterTheClose.service.levels(["FIXA"]))[0]!);
  assert.equal(done.asOf, "2026-09-10", "once closed, today is a session like any other");
  assert.equal(done.sessions, mid.sessions + 1);
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
  await refused({ symbols: ["FIXA"], timeframe: "10y" }, /timeframe/i);
  await refused({ symbols: ["FIXA"], adjustment: "split" }, /adjustment/i);   // no unknown knobs, so a wrong one is never silently ignored
  const weekly = await m.call({ symbols: ["FIXA"], timeframe: "5y" });
  assert.ok(!weekly.isError, "but the weekly window is a timeframe the tool accepts");
  assert.equal(JSON.parse(weekly.content[0]!.text).levels[0].requested, "5y");
  const off = await overMcp(t, { ready: false });
  const failed = await off.call({ symbols: ["FIXA"] });
  assert.equal(failed.isError, true);
  const body = JSON.parse(failed.content[0]!.text);
  assert.match(body.error, /Connect Robinhood market data first/);
  assert.equal(body.next.next.tool, "connect_robinhood");
});
