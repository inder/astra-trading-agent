import { test } from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { levels, parseLevelsSettings, movingAverageSeries } from "../src/levels.ts";
import { overview, portfolioReport, type ReportAccount } from "../src/report.ts";
import { TradingAgentService } from "../src/agent-service.ts";
import { syntheticBars } from "./levels-fixture.ts";

const bars = syntheticBars();
const computed = levels(bars, parseLevelsSettings());
const series = bars.time.map((time, i) => ({ time, value: bars.close[i]! }));
const account = (over: Partial<ReportAccount> = {}): ReportAccount => ({
  label: "••••3312 individual",
  totals: { value: 125340.55, cash: 2200, dayChange: -812.4, totalReturn: 18430.22 },
  holdings: [{ holding: { symbol: "FIXA", shares: 120, averageCost: 41.22 }, levels: computed, series: { daily: series } }],
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
  assert.match(html, /held \d+</, "a zone says how often it held, in one word used everywhere");
  assert.ok(!/\d+ tests|\d+×/.test(html), "and never in a second vocabulary");
  assert.match(html, /Avg cost\/share/); assert.match(html, /Unrealized P&amp;L/); assert.match(html, /Last close/);
  assert.match(html, /near support|near resistance/, "the flag says which side it is near");
  // Equities in the table against the account's own value, which counts options and crypto too.
  assert.match(html, /Equities here/);
  assert.match(html, /is not in the table below/, "and the difference is explained rather than left to be found");
  assert.match(html, /@media print/, "and it is written to be printed");
  // Exactly one script — the print button — and the page's own policy names its hash, so nothing that reached the
  // markup could run even if the escaping above ever failed.
  assert.equal((html.match(/<script/g) ?? []).length, 1, "one script, the print button");
  const policy = html.match(/content-security-policy" content="([^"]+)"/)![1]!;
  const hash = policy.match(/script-src 'sha256-([^']+)'/)![1]!;
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
  assert.equal(createHash("sha256").update(script).digest("base64"), hash, "the policy pins this exact script");
  assert.match(policy, /default-src 'none'/);
  assert.match(html, /id="print"/); assert.match(html, /Print or save as PDF/);
});
test("technicals expand to a readable chart, one per timeframe, with no script to switch them", () => {
  const html = portfolioReport({ accounts: [account()], generatedAt: "2026-09-16T12:00:00.000Z", timeframe: "2-year" });
  assert.match(html, /<details class="technicals"><summary>Technicals — price, cost and levels/,
    "collapsed until asked for, and its label says what opening it gives you");
  assert.match(html, /<svg class="chart"/);
  assert.match(html, /<path class="line" d="M[\d. LM]+"/, "the price is a path");
  assert.match(html, /<g class="s"><rect/, "support bands are drawn behind it");
  // Tabs are radio inputs, so switching timeframes needs no script and the choice survives printing.
  const tabs = (html.match(/type="radio"/g) ?? []).length;
  assert.equal(tabs, computed.frames.length, `one tab per frame (${computed.frames.length})`);
  assert.equal((html.match(/class="pane"/g) ?? []).length, computed.frames.length);
  assert.equal((html.match(/ checked>/g) ?? []).length, 1, "exactly one tab starts selected");
  for (const frame of computed.frames) assert.ok(html.includes(`>${frame.label}</label>`), `${frame.label} is a tab`);
  // The zones are labelled on the chart itself, which is the point of expanding it.
  assert.match(html, /<text x="\d+" y="[\d.]+">\$[\d,]+\.\d\d–[\d.]+<tspan class="tests"> \d+ held/);
  assert.match(html, /class="title" x="0"[^>]*>FIXA · /, "every chart names its stock and timeframe, for print");
  assert.match(html, /class="costlabel"[^>]*>\$41\.22 your cost/, "and shows where the holding was bought");
  // Labels must fit: the plot stops far enough left that the longest label has room.
  const labels = [...html.matchAll(/<text x="(\d+)" y="[\d.]+">(\$[\d,.–]+)<tspan class="tests">([^<]+)<\/tspan>/g)];
  assert.ok(labels.length, "there are zone labels");
  for (const [, x, head, tail] of labels)
    assert.ok(Number(x) + (head!.length + tail!.length) * 6.2 <= 960, `"${head}${tail}" fits inside the chart`);
  // And within any one chart they must not sit on top of one another.
  const charts = [...html.matchAll(/<svg class="chart"[\s\S]*?<\/svg>/g)].map(m => m[0]);
  assert.ok(charts.length >= 2, "there are several charts to check");
  for (const svg of charts) {
    const ys = [...svg.matchAll(/<text x="\d+" y="([\d.]+)">\$/g)].map(m => Number(m[1])).sort((a, b) => a - b);
    assert.ok(ys.every((v, i) => i === 0 || v - ys[i - 1]! >= 12.9),
      `labels are kept apart: ${svg.match(/class="title"[^>]*>([^<]+)/)?.[1]} has ${ys.join(", ")}`);
  }
  assert.ok(html.length < 250_000, `a one-holding report is ${Math.round(html.length / 1024)} KB, not megabytes`);
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
test("past the charting cap the largest positions keep their charts, and the rest say why they have none", async t => {
  const dataDirectory = mkdtempSync(join(tmpdir(), "astra-report-cap-"));
  const outputDirectory = mkdtempSync(join(tmpdir(), "astra-report-cap-out-"));
  // Twenty-three holdings, priced so the alphabetical order and the size order disagree: AAA is the smallest.
  const positions = Array.from({ length: 23 }, (_, i) => ({
    symbol: `H${String(i).padStart(2, "0")}`, quantity: "10", average_buy_price: String(100 - i),
  }));
  const charted: string[] = [];
  const broker = {
    accountRead: async (tool: string) => {
      if (tool === "get_accounts") return { data: { accounts: [{ account_number: "112233312", brokerage_account_type: "individual", is_default: true }] } };
      if (tool === "get_portfolio") return { data: { portfolio: { total_market_value: "51000", cash: "1000" } } };
      return { data: { positions, next_cursor: null } };
    },
    read: async (tool: string, args: any) => {
      const symbol = args.symbols[0];
      charted.push(symbol);
      return { data: { results: [{ symbol, interval: "day", bounds: "regular",
        bars: bars.time.map((t, i) => ({ begins_at: `${t}T00:00:00Z`, open_price: String(bars.open[i]), high_price: String(bars.high[i]),
          low_price: String(bars.low[i]), close_price: String(bars.close[i]), volume: "1000", session: "reg" })) }] } };
    },
    status: () => ({ state: "connected", accountListAvailable: true, accountToolsAvailable: true, connectionId: "c1", paperDataAvailable: true }),
    close: async () => {},
  } as any;
  const service = new TradingAgentService(dataDirectory, undefined, broker,
    { ready: () => true, clock: () => Date.parse("2026-09-16T12:00:00Z"), auto: false });
  t.after(async () => { await service.close(); rmSync(dataDirectory, { recursive: true, force: true }); rmSync(outputDirectory, { recursive: true, force: true }); });

  const [chosen] = await service.accounts();
  const written = await service.portfolioReport([chosen!.handle], outputDirectory);
  assert.equal(written.holdings, 23, "every holding is still listed");
  const bar = charted.filter(s => s.startsWith("H"));
  assert.equal(new Set(bar).size, 20, "only the cap's worth of bar reads are spent");
  assert.ok(!bar.includes("H20") && !bar.includes("H22"), "and they are the largest, not the first alphabetically");
  const html = readFileSync(written.path, "utf8");
  assert.match(html, /charts the 20 largest positions/, "an uncharted holding says why, rather than reading as unreadable");
  assert.ok(!html.includes("not read"), "and never with a reason that explains nothing");
});
test("the report is reachable on loopback, and that link serves only reports this process wrote", async t => {
  const { ReportServer } = await import("../src/report-server.ts");
  const directory = mkdtempSync(join(tmpdir(), "astra-serve-"));
  const file = join(directory, "r.html");
  const server = new ReportServer();
  t.after(async () => { await server.close(); rmSync(directory, { recursive: true, force: true }); });
  writeFileSync(file, portfolioReport({ accounts: [account()], generatedAt: "2026-09-16T12:00:00.000Z", timeframe: "2-year" }));

  const url = await server.publish(file);
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/r\/[\w-]{12}$/, "loopback only, and an unguessable name");
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.match(await page.text(), /••••3312 individual/);

  // A name nobody minted is not a file path, so there is nothing to traverse to.
  assert.equal((await fetch(`${new URL(url).origin}/r/${encodeURIComponent("../../etc/passwd")}`)).status, 404);
  assert.equal((await fetch(`${new URL(url).origin}/`)).status, 404);
  // A page on another origin must not be able to read the report, and a request aimed at another name must not
  // either. Raw requests, because fetch will not let a caller set Host or Origin.
  const raw = (headers: Record<string, string>, method = "GET") => new Promise<number>((ok, fail) => {
    const { hostname, port, pathname } = new URL(url);
    const request = httpRequest({ hostname, port, path: pathname, method, headers }, response => {
      response.resume(); ok(response.statusCode ?? 0);
    });
    request.on("error", fail); request.end();
  });
  assert.equal(await raw({ host: `127.0.0.1:${new URL(url).port}`, origin: "https://example.com" }), 403, "cross-origin");
  assert.equal(await raw({ host: `127.0.0.1:${new URL(url).port}` }, "POST"), 403, "not a GET");
  assert.equal(await raw({ host: "example.com" }), 403, "a foreign Host, as DNS rebinding would send");
  assert.equal(await raw({ host: `localhost:${new URL(url).port}` }), 200, "but localhost is the same machine");
  // Deleting the file is answered honestly rather than with a stale copy.
  rmSync(file);
  assert.equal((await fetch(url)).status, 410);
});
test("the overview says enough for the chat to summarize, and leaves the detail in the report", () => {
  const input = { accounts: [account(), account({ label: "••••6777 roth ira",
    totals: { value: 40000, cash: 0, dayChange: 120, totalReturn: 900 },
    holdings: [
      { holding: { symbol: "FIXA", shares: 10, averageCost: 200 }, levels: computed, series: { daily: series } },
      { holding: { symbol: "QUIET", shares: 5, averageCost: 10 }, unavailable: "no usable daily price history" },
    ] })], generatedAt: "2026-09-16T12:00:00.000Z", timeframe: "2-year" };
  const summary = overview(input);
  assert.equal(summary.asOf, "2026-09-16");
  assert.deepEqual(summary.accounts.map(a => [a.label, a.holdings]), [["••••3312 individual", 1], ["••••6777 roth ira", 2]]);
  assert.equal(summary.totalValue, 165340.55, "totals add up across the accounts");
  assert.equal(summary.totalDayChange, -692.4);
  assert.deepEqual(summary.unreadable, ["QUIET"], "and it names what could not be read");
  // FIXA sits inside a day's range of a level in this fixture, so it is what the chat should mention first.
  assert.ok(summary.near.some(n => n.symbol === "FIXA" && /support|resistance/.test(n.side) && n.tests > 0));
  assert.ok(summary.best.length && summary.best.every((g, i, all) => i === 0 || g.gainPct <= all[i - 1]!.gainPct), "best runs downward");
  assert.ok(!summary.worst.some(w => summary.best.some(b => b.symbol === w.symbol)),
    "with only a couple of holdings, best covers them and worst repeats nothing");
  // Small enough to narrate: this is a paragraph's worth of facts, not the report.
  assert.ok(JSON.stringify(summary).length < 1200, `${JSON.stringify(summary).length} bytes`);
});
test("the moving-average series the chart could draw matches the numbers the report states", () => {
  // Guards the rule the whole design rests on: a picture is a view of the same answer, never a second computation.
  const drawn = movingAverageSeries(bars, [10]).at(0)!.points.at(-1)!.value;
  assert.ok(Math.abs(drawn - computed.averages.find(a => a.period === 10)!.value!) < 1e-9);
});
