import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { levels, parseLevelsSettings, movingAverageSeries } from "../src/levels.ts";
import { portfolioReport, type ReportAccount } from "../src/report.ts";
import { TradingAgentService } from "../src/agent-service.ts";
import { syntheticBars } from "./levels-fixture.ts";

const bars = syntheticBars();
const computed = levels(bars, parseLevelsSettings());
const series = bars.time.map((time, i) => ({ time, value: bars.close[i]! }));
const account = (over: Partial<ReportAccount> = {}): ReportAccount => ({
  label: "••••3312 individual",
  totals: { value: 125340.55, cash: 2200, dayChange: -812.4, totalReturn: 18430.22 },
  holdings: [{ holding: { symbol: "FIXA", shares: 120, averageCost: 41.22 }, levels: computed, series }],
  skipped: 0, truncated: false, ...over,
});

test("the report states the figures a holder needs, and marks a stock sitting on a level", () => {
  const html = portfolioReport({ accounts: [account()], generatedAt: "2026-09-16T12:00:00.000Z", timeframe: "2-year" });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /••••3312 individual/);
  assert.match(html, /\$125,341/, "account value, to the dollar — a header is not the place for cents");
  assert.match(html, /−\$812/, "a loss is shown with a minus, not a bracket");
  assert.match(html, /FIXA/);
  assert.match(html, /120/, "shares");
  assert.match(html, /\$41\.22/, "cost basis");
  // Gain: 120 shares at the fixture's last close against a $41.22 cost.
  const gain = 120 * computed.price - 120 * 41.22;
  assert.ok(html.includes(`$${Math.round(gain).toLocaleString("en-US")}`), `gain of ${gain} appears`);
  assert.match(html, /Support below/); assert.match(html, /Resistance above/);
  assert.match(html, /tests</, "a zone says how often it held");
  assert.ok(!/<script/i.test(html), "nothing to execute");
  assert.match(html, /@media print/, "and it is written to be printed");
});
test("a chart is drawn as SVG, small enough to print and to put twenty of on a page", () => {
  const html = portfolioReport({ accounts: [account()], generatedAt: "2026-09-16T12:00:00.000Z", timeframe: "2-year" });
  assert.match(html, /<svg class="spark"/);
  assert.match(html, /<path class="line" d="M[\d. LM]+"/, "the price is a path");
  assert.match(html, /<rect class="s"/, "support bands are drawn behind it");
  assert.ok(html.length < 120_000, `a one-holding report is ${Math.round(html.length / 1024)} KB, not megabytes`);
  // No library, no fonts, no network: a printed page must not depend on anything being reachable.
  assert.ok(!/https?:\/\//.test(html.replace(/xmlns="[^"]*"/g, "")), "nothing is fetched");
});
test("a holding without levels still appears, saying why, rather than being dropped", () => {
  const html = portfolioReport({ accounts: [account({
    holdings: [{ holding: { symbol: "QUIET", shares: 5, averageCost: null }, unavailable: "no usable daily price history from Robinhood" }],
    skipped: 2, truncated: true })], generatedAt: "2026-09-16T12:00:00.000Z", timeframe: "2-year" });
  assert.match(html, /QUIET/);
  assert.match(html, /no usable daily price history/);
  assert.match(html, /2 holdings could not be read/, "and the ones that could not be read at all are counted");
  assert.match(html, /more holdings than one report can page through/);
});
test("what a provider or an issuer wrote cannot become markup", () => {
  const html = portfolioReport({ accounts: [account({
    label: '<script>alert(1)</script> "roth"',
    holdings: [{ holding: { symbol: "A&B<C", shares: 1, averageCost: 1 }, unavailable: "<img src=x onerror=alert(1)>" }],
  })], generatedAt: "2026-09-16T12:00:00.000Z", timeframe: "2-year" });
  assert.ok(!html.includes("<script>alert"), "a label cannot open a tag");
  assert.ok(!html.includes("<img src=x"), "nor can a reason");
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /A&amp;B&lt;C/);
});
test("the report is written where it was asked for, and nothing about it reaches the data directory", async t => {
  const dataDirectory = mkdtempSync(join(tmpdir(), "astra-report-data-"));
  const outputDirectory = mkdtempSync(join(tmpdir(), "astra-report-out-"));
  const barPayload = (symbol: string) => ({ data: { results: [{ symbol, interval: "day", bounds: "regular",
    bars: bars.time.map((t, i) => ({ begins_at: `${t}T00:00:00Z`, open_price: String(bars.open[i]), high_price: String(bars.high[i]),
      low_price: String(bars.low[i]), close_price: String(bars.close[i]), volume: "1000", session: "reg" })) }] } });
  const reads: string[] = [];
  const broker = {
    accountRead: async (tool: string) => {
      reads.push(tool);
      if (tool === "get_accounts") return { data: { accounts: [{ account_number: "112233312", brokerage_account_type: "individual", is_default: true }] } };
      if (tool === "get_portfolio") return { data: { portfolio: { total_market_value: "51000", cash: "1000" } } };
      return { data: { positions: [{ symbol: "FIXA", quantity: "120", average_buy_price: "41.22" }], next_cursor: null } };
    },
    read: async (tool: string, args: any) => { reads.push(tool); return barPayload(args.symbols[0]); },
    status: () => ({ state: "connected", accountListAvailable: true, accountToolsAvailable: true, connectionId: "c1", paperDataAvailable: true }),
    close: async () => {},
  } as any;
  const service = new TradingAgentService(dataDirectory, undefined, broker,
    { ready: () => true, clock: () => Date.parse("2026-09-16T12:00:00Z"), auto: false });
  t.after(async () => { await service.close(); rmSync(dataDirectory, { recursive: true, force: true }); rmSync(outputDirectory, { recursive: true, force: true }); });

  const before = readdirSync(dataDirectory);
  const [chosen] = await service.accounts();
  const written = await service.portfolioReport([chosen!.handle], outputDirectory);
  assert.equal(written.accounts, 1); assert.equal(written.holdings, 1);
  assert.match(written.path, /portfolio-2026-09-16\.html$/);
  const html = readFileSync(written.path, "utf8");
  assert.match(html, /FIXA/); assert.match(html, /••••3312 individual/); assert.match(html, /\$51,000/);
  assert.deepEqual(readdirSync(dataDirectory), before, "an account never reaches the data directory");
  assert.ok(reads.includes("get_portfolio") && reads.includes("get_equity_positions"), "it reads totals and positions");
  assert.ok(!reads.some(r => /order|cancel|place/.test(r)), "and nothing else");
});
test("the moving-average series the chart could draw matches the numbers the report states", () => {
  // Guards the rule the whole design rests on: a picture is a view of the same answer, never a second computation.
  const drawn = movingAverageSeries(bars, [10]).at(0)!.points.at(-1)!.value;
  assert.ok(Math.abs(drawn - computed.averages.find(a => a.period === 10)!.value!) < 1e-9);
});
