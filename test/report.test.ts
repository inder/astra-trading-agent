import { test } from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  label: "••••0000 individual",
  totals: { value: 125340.55, cash: 2200, byClass: [{ label: "Stocks", value: 15294 }] },
  holdings: [{ holding: { symbol: "FIXA", shares: 120, averageCost: 41.22 }, levels: computed, series: { daily: series } }],
  skipped: 0, truncated: false, ...over,
});

test("the report states the figures a holder needs, and marks a stock sitting on a level", () => {
  const html = portfolioReport({ accounts: [account()], generatedAt: "2026-09-16T12:00:00.000Z" });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /••••0000 individual/);
  assert.match(html, /\$125,341/, "account value, to the dollar — a header is not the place for cents");
  assert.match(html, /−0\.2%/, "a negative is shown with a minus, not a bracket");
  assert.ok(!/\(\$[\d,]/.test(html), "and never in accountants' brackets");
  assert.match(html, /FIXA/);
  assert.match(html, /120/, "shares");
  assert.match(html, /\$41\.22/, "cost basis");
  // Gain: 120 shares at the fixture's last close against a $41.22 cost.
  const gain = 120 * computed.price - 120 * 41.22;
  assert.ok(html.includes(`$${Math.round(gain).toLocaleString("en-US")}`), `gain of ${gain} appears`);
  assert.match(html, /Support below/); assert.match(html, /Resistance above/);
  assert.match(html, /held \d+</, "a zone says how often it held, in one word used everywhere");
  assert.ok(!/\d+ tests|\d+×/.test(html), "and never in a second vocabulary");
  assert.match(html, /Avg cost\/share/); assert.match(html, /Unrealized P&amp;L/); assert.match(html, />Price</);
  // Every price says what it is. A closing price and an after-hours trade are different facts, and the column used to
  // be headed "Last close" whatever it held — which is how a report misleads without stating a wrong number.
  assert.match(html, /close [A-Z][a-z]{2} \d+, \d{4}/, "a close names its session");
  assert.ok(!/Last close/.test(html), "and nothing claims to be a close without naming one");
  assert.match(html, /near support|near resistance/, "the flag says which side it is near");
  // The header names every class Robinhood reports a value for, so what the table leaves out is stated rather than
  // lumped. This fixture is stocks only, so there is nothing else to name and no note to make.
  assert.match(html, /<dt>Stocks<\/dt>/);
  assert.ok(!/Equities here/.test(html), "the old stat that existed only to paper over the gap is gone");
  assert.ok(!/Today<\/dt>|Total return<\/dt>/.test(html), "and nothing claims a figure the provider never sends");
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
  const html = portfolioReport({ accounts: [account()], generatedAt: "2026-09-16T12:00:00.000Z" });
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
    skipped: 2, truncated: true })], generatedAt: "2026-09-16T12:00:00.000Z" });
  assert.match(html, /QUIET/);
  assert.match(html, /no usable daily price history/);
  assert.match(html, /2 holdings could not be read/, "and the ones that could not be read at all are counted");
  assert.match(html, /more holdings than one report can page through/);
  // The Stocks figure is Robinhood's own and counts these holdings. The note used to say the total excluded them,
  // which was true of the subtotal Astra computed and is a misstatement of the one it now shows.
  assert.match(html, /still counted in the figures above/);
  assert.ok(!/stocks total excludes/.test(html), "the note does not describe a total that no longer exists");
});
test("what a provider or an issuer wrote cannot become markup", () => {
  const html = portfolioReport({ accounts: [account({
    label: '<script>alert(1)</script> "roth"',
    holdings: [{ holding: { symbol: "A&B<C", shares: 1, averageCost: 1 }, unavailable: "<img src=x onerror=alert(1)>" }],
  })], generatedAt: "2026-09-16T12:00:00.000Z" });
  assert.ok(!html.includes("<script>alert"), "a label cannot open a tag");
  assert.ok(!html.includes("<img src=x"), "nor can a reason");
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /A&amp;B&lt;C/);
});
test("an account holding more than stocks says so, by class and by figure", () => {
  // The founder's complaint: "it does not include my options positions though. only equity positions." Robinhood
  // reports a value for every class it supports, so the account can be itemized before a single contract is listed.
  const html = portfolioReport({ accounts: [account({ totals: { value: 500000, cash: 10000, byClass: [
    { label: "Stocks", value: 15294 }, { label: "Options", value: 470000 }, { label: "Crypto", value: 4706 },
  ] } })], generatedAt: "2026-09-16T12:00:00.000Z" });
  assert.match(html, /<dt>Options<\/dt><dd>\$470,000<\/dd>/, "options are a figure in the header, not an absence");
  assert.match(html, /<dt>Crypto<\/dt><dd>\$4,706<\/dd>/);
  // And the table says what it is and is not, naming each class rather than lumping them as "options and crypto".
  assert.match(html, /The table below lists this account&#39;s stocks\./);
  assert.match(html, /Also counted in the account value above, but not listed here: options \(\$470,000\), crypto \(\$4,706\)\./);

  // An account can hold no stocks at all — one of the founder's holds only options. A note opening "the table below
  // lists this account's stocks" would then describe an empty table, and "its options ... is counted" is not English.
  const optionsOnly = portfolioReport({ accounts: [account({ holdings: [], totals: {
    value: 100000, cash: 1000, byClass: [{ label: "Options", value: 99000 }] } })], generatedAt: "2026-09-16T12:00:00.000Z" });
  assert.match(optionsOnly, /This account holds no stocks, so the table below is empty\./);
  assert.match(optionsOnly, /Counted in the account value above, but not listed here: options \(\$99,000\)\./);
  assert.ok(!/&#39;s stocks\./.test(optionsOnly), "and it does not describe stocks it does not have");
  assert.match(optionsOnly, /<dt>Options<\/dt><dd>\$99,000<\/dd>/, "the value is still stated");
  assert.ok(!/<dt>Stocks<\/dt>/.test(optionsOnly), "with no stocks line invented for it");
  assert.ok(!/<thead>/.test(optionsOnly), "and no empty table: eight column headers over nothing read as a failure");

  // Whatever the account value holds that the header has not named gets a line of its own. Robinhood folds things
  // into the total that no class field covers — pending deposits today, an eighth class tomorrow — and those would
  // otherwise vanish between the lines, which is the failure this whole change exists to end.
  const gap = portfolioReport({ accounts: [account({ totals: { value: 100000, cash: 1000, byClass: [
    { label: "Stocks", value: 15294 }] } })], generatedAt: "2026-09-16T12:00:00.000Z" });
  assert.match(gap, /<dt>Not itemized<\/dt><dd>\$83,706<\/dd>/, "the remainder is shown, not absorbed");
  // It is a remainder, never an assertion that the parts must agree: under half a dollar there is no line at all.
  const exact = portfolioReport({ accounts: [account({ totals: { value: 16294.2, cash: 1000, byClass: [
    { label: "Stocks", value: 15294 }] } })], generatedAt: "2026-09-16T12:00:00.000Z" });
  assert.ok(!/Not itemized/.test(exact), "and rounding noise is not a discrepancy");
  const unknownCash = portfolioReport({ accounts: [account({ totals: { value: 100000, cash: null, byClass: [] } })],
    generatedAt: "2026-09-16T12:00:00.000Z" });
  assert.ok(!/Not itemized/.test(unknownCash), "a remainder needs both ends known to mean anything");

  const overview_ = overview({ accounts: [account({ totals: { value: 500000, cash: 10000, byClass: [
    { label: "Options", value: 470000 }] } })], generatedAt: "2026-09-16T12:00:00.000Z" });
  assert.deepEqual(overview_.accounts[0]!.byClass, [{ label: "Options", value: 470000 }],
    "so the chat can say it without the report being open");
});
test("the options line tells apart the four things a bare count cannot", () => {
  // A count alone renders identically for: holds none, read failed, grant lacks the tool, and every row unreadable.
  // The last is the one that matters — the normalizer is keyed field by field to a captured payload shape, and a
  // provider that renames a field does not error, it drops every row. "No options" to someone who holds options.
  const withOptions = (options: ReportAccount["options"]) => portfolioReport({ accounts: [account({ options,
    totals: { value: 500000, cash: 1000, byClass: [{ label: "Stocks", value: 15294 }, { label: "Options", value: 470000 }] },
  })], generatedAt: "2026-09-16T12:00:00.000Z" });

  assert.match(withOptions({ count: 12, skipped: 0, truncated: false }), /options \(\$470,000, 12 open contracts\)/);
  assert.match(withOptions({ count: 1, skipped: 0, truncated: false }), /1 open contract\)/, "and it counts in English");
  assert.match(withOptions("unreadable"), /options \(\$470,000, the contracts behind it could not be read\)/,
    "a read that failed is not an account that holds nothing");
  assert.match(withOptions({ count: 0, skipped: 40, truncated: false }), /none of its 40 contract rows could be read/,
    "and neither is a payload whose every row was dropped — the shape-drift case");
  // No rows, nothing dropped, and an account worth $470,000 in options: the provider disagreeing with itself. This
  // is the shape a payload wrapper Astra does not know about produces, and the last state that could still have been
  // reported as a fact — "0 open contracts" takes one side of a contradiction and states it.
  assert.match(withOptions({ count: 0, skipped: 0, truncated: false }), /no contract rows came back for it/);
  assert.ok(!/0 open contracts/.test(withOptions({ count: 0, skipped: 0, truncated: false })));
  assert.match(withOptions({ count: 20, skipped: 0, truncated: true }), /20\+ open contracts, more than one report can page through/,
    "a count that stopped early says so rather than looking authoritative");
  assert.match(withOptions({ count: 12, skipped: 3, truncated: false }), /12 open contracts, and 3 rows that could not be read/);
  // Nothing known at all — the options figure stands alone rather than gaining a claim about its contracts.
  assert.match(withOptions(undefined), /options \(\$470,000\)/);
});
test("a stock with too little history shows its price, not zero, and says why it has no levels", () => {
  // A holding listed recently has real sessions but too few to measure a zone. The engine returns levels with every
  // frame unavailable — and it used to leave price at 0, which put $0.00 and −100% in the money columns and made the
  // stock the portfolio's worst performer in the overview the chat reads aloud. Only the levels are unknown.
  const thin = levels({ time: bars.time.slice(-5), open: bars.open.slice(-5), high: bars.high.slice(-5),
    low: bars.low.slice(-5), close: bars.close.slice(-5) }, parseLevelsSettings());
  assert.ok(thin.frames.every(f => f.unavailable), "no frame could be measured");
  assert.equal(thin.price, bars.close.at(-1), "but the price is the last close, not zero");

  const input = { accounts: [account({
    holdings: [{ holding: { symbol: "NEWCO", shares: 100, averageCost: 40 }, levels: thin, series: { daily: series } }],
  })], generatedAt: "2026-09-16T12:00:00.000Z" };
  const html = portfolioReport(input);
  assert.ok(!/\$0\.00/.test(html), "no zero price reaches the table");
  assert.ok(!/−100\.0%/.test(html), "and no total loss is invented");
  assert.match(html, /only \d+ sessions of history/, "the reason is on the page, not only in the tool's JSON");
  // The warning sits beside the row rather than inside the collapsed disclosure, which print drops when unopened.
  const beforeDetails = html.slice(0, html.indexOf("<details"));
  assert.match(beforeDetails, /only \d+ sessions of history/, "and is visible without expanding anything");
  const view = overview(input);
  assert.ok(!view.worst.some(w => w.symbol === "NEWCO" && w.gainPct <= -99), "the chat is not told it lost everything");
});
test("a price that is not a closing price is never shown as one", () => {
  // The case from 2026-09-16: Robinhood had not published that day's daily bar hours after the close, so the newest
  // trade was an after-hours print. Shown under a column headed "Last close", it read as the day's close.
  const afterHours = { ...computed, priceSource: "after-hours" as const, priceAt: "2026-09-16T21:42:00.000Z" };
  const html = portfolioReport({ accounts: [account({
    holdings: [{ holding: { symbol: "FIXA", shares: 120, averageCost: 41.22 }, levels: afterHours, series: { daily: series } }],
  })], generatedAt: "2026-09-16T23:36:00.000Z" });
  // \s, not a literal space: ICU separates the time from AM/PM with U+202F, a narrow no-break space.
  assert.match(html, /after hours Sep 16, 5:42\sPM ET/, "it says what it is, and when, in the market's own timezone");
  assert.ok(!/Last close/.test(html), "and never under a heading that calls it a close");
  assert.match(html, /after hours<\/text>/, "the chart's own price line says so too");
  // The levels themselves still come from the last settled session, whatever the price is.
  assert.match(html, new RegExp(`${computed.frames.find(f => !f.unavailable)!.label}`), "frames are unchanged");

  const preMarket = { ...computed, priceSource: "pre-market" as const, priceAt: "2026-09-16T12:10:00.000Z" };
  const early = portfolioReport({ accounts: [account({
    holdings: [{ holding: { symbol: "FIXA", shares: 120, averageCost: 41.22 }, levels: preMarket, series: { daily: series } }],
  })], generatedAt: "2026-09-16T12:15:00.000Z" });
  assert.match(early, /pre-market Sep 16, 8:10\sAM ET/);
});
test("the same stock in two accounts gets two independent sets of tabs, and a total nobody could read is not a total", () => {
  const two = { accounts: [account(), account({ label: "••••1234 roth ira" })], generatedAt: "2026-09-16T12:00:00.000Z" };
  const html = portfolioReport(two);
  // Radio groups are document-scoped. Sharing a name would fuse the two tab sets into one group: both would parse as
  // checked, the last would win, and the first account's panes would every one be hidden — an empty drawer.
  const names = [...html.matchAll(/name="(tf-[^"]+)"/g)].map(m => m[1]!);
  const ids = [...html.matchAll(/ id="(tf-[^"]+)"/g)].map(m => m[1]!);
  assert.equal(new Set(names).size, 2, "one group per holding, not one shared by both accounts");
  assert.equal(new Set(ids).size, ids.length, "and every input has its own id");
  assert.equal((html.match(/ checked>/g) ?? []).length, 2, "each account's tabs start with one selected");
  for (const [, forId] of html.matchAll(/<label for="(tf-[^"]+)"/g)) assert.ok(ids.includes(forId!), `${forId} exists`);

  // A total is every account or it is nothing. One unreadable account used to be summed as zero, producing a figure
  // that looked like the whole portfolio and was short by an account — and the chat is told to read it out.
  const partial = overview({ ...two, accounts: [two.accounts[0]!, account({ label: "••••1234 roth ira",
    totals: { value: null, cash: null, byClass: [] } })] });
  assert.equal(partial.totalValue, null, "a total that cannot be complete is not reported");
  assert.deepEqual(partial.unreadableAccounts, ["••••1234 roth ira"], "and the account that could not be read is named");
  assert.equal(overview(two).totalValue, 125340.55 * 2, "two readable accounts still add up");
});
test("the report lands under the data directory, readable by nobody else, and a second one is a second file", async t => {
  const dataDirectory = mkdtempSync(join(tmpdir(), "astra-report-data-"));
  const barPayload = (symbol: string) => ({ data: { results: [{ symbol, interval: "day", bounds: "regular",
    bars: bars.time.map((t, i) => ({ begins_at: `${t}T00:00:00Z`, open_price: String(bars.open[i]), high_price: String(bars.high[i]),
      low_price: String(bars.low[i]), close_price: String(bars.close[i]), volume: "1000", session: "reg" })) }] } });
  const reads: string[] = [];
  const broker = {
    accountRead: async (tool: string) => {
      reads.push(tool);
      if (tool === "get_accounts") return { data: { accounts: [{ account_number: "100000000", brokerage_account_type: "individual", is_default: true }] } };
      if (tool === "get_portfolio") return { data: { portfolio: { total_value: "51000", cash: "1000", equity_value: "50000" } } };
      return { data: { positions: [{ symbol: "FIXA", quantity: "120", average_buy_price: "41.22" }], next_cursor: null } };
    },
    read: async (tool: string, args: any) => { reads.push(tool); return barPayload(args.symbols[0]); },
    status: () => ({ state: "connected", accountListAvailable: true, accountToolsAvailable: true, connectionId: "c1", paperDataAvailable: true }),
    close: async () => {},
  } as any;
  const service = new TradingAgentService(dataDirectory, undefined, broker,
    { ready: () => true, clock: () => Date.parse("2026-09-16T12:00:00Z"), auto: false });
  t.after(async () => { await service.close(); rmSync(dataDirectory, { recursive: true, force: true }); });

  const [chosen] = await service.accounts();
  const written = await service.portfolioReport([chosen!.handle]);
  assert.equal(written.accounts, 1); assert.equal(written.holdings, 1);
  // Where the file goes is not an argument: it is the reports folder under the data directory, and nowhere else.
  assert.equal(written.path, join(dataDirectory, "reports", written.path.split("/").pop()!));
  assert.match(written.path, /portfolio-2026-09-16-[0-9a-f]{8}\.html$/, "dated, and unique so today's second report cannot overwrite the first");
  assert.equal(statSync(written.path).mode & 0o777, 0o600, "readable only by its owner");
  assert.equal(statSync(join(dataDirectory, "reports")).mode & 0o777, 0o700);
  const html = readFileSync(written.path, "utf8");
  assert.match(html, /FIXA/); assert.match(html, /••••0000 individual/); assert.match(html, /\$51,000/);
  assert.ok(reads.includes("get_portfolio") && reads.includes("get_equity_positions"), "it reads totals and positions");
  assert.ok(!reads.some(r => /order|cancel|place/.test(r)), "and nothing else");
  // The journal, the checkpoints and the saved runs are the data directory's own files; an account is in none of them.
  const second = await service.portfolioReport([chosen!.handle]);
  assert.notEqual(second.path, written.path, "a second report the same day is a second file, not an overwrite");
  assert.deepEqual(readdirSync(dataDirectory), ["reports"], "and nothing about an account is written anywhere else");
});
test("past the charting cap the largest positions keep their charts, and the rest say why they have none", async t => {
  const dataDirectory = mkdtempSync(join(tmpdir(), "astra-report-cap-"));
  // Twenty-three holdings, priced so the alphabetical order and the size order disagree: H22 is the smallest. Two of
  // them are transferred-in shares the provider gave no cost for — they have no size to rank by and must not be
  // ranked last by a zero they never had, so they chart first and the two smallest priced holdings lose out.
  const positions = Array.from({ length: 23 }, (_, i) => ({
    symbol: `H${String(i).padStart(2, "0")}`, quantity: "10", average_buy_price: String(100 - i),
  })).concat([{ symbol: "NOCOSTA", quantity: "9" }, { symbol: "NOCOSTB", quantity: "11" }] as any);
  const charted: string[] = [];
  const broker = {
    accountRead: async (tool: string) => {
      if (tool === "get_accounts") return { data: { accounts: [{ account_number: "100000000", brokerage_account_type: "individual", is_default: true }] } };
      if (tool === "get_portfolio") return { data: { portfolio: { total_value: "51000", cash: "1000", equity_value: "50000" } } };
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
  t.after(async () => { await service.close(); rmSync(dataDirectory, { recursive: true, force: true }); });

  const [chosen] = await service.accounts();
  const written = await service.portfolioReport([chosen!.handle]);
  assert.equal(written.holdings, 25, "every holding is still listed");
  const asked = new Set(charted);
  assert.equal(asked.size, 20, "only the cap's worth of bar reads are spent");
  assert.ok(asked.has("NOCOSTA") && asked.has("NOCOSTB"), "a holding with no cost to rank by is charted, not ranked last");
  assert.ok(!asked.has("H21") && !asked.has("H22"), "and the smallest priced holdings are the ones that lose out");
  assert.ok(asked.has("H00"), "the largest position keeps its chart");
  const html = readFileSync(written.path, "utf8");
  assert.match(html, /charts the 20 largest positions/, "an uncharted holding says why, rather than reading as unreadable");
  assert.ok(!html.includes("not read"), "and never with a reason that explains nothing");
});
test("two reports asked for at once share one listener, and a closed server starts a new one", async t => {
  const { ReportServer } = await import("../src/report-server.ts");
  const directory = mkdtempSync(join(tmpdir(), "astra-serve-two-"));
  const server = new ReportServer();
  t.after(async () => { await server.close(); rmSync(directory, { recursive: true, force: true }); });
  const page = portfolioReport({ accounts: [account()], generatedAt: "2026-09-16T12:00:00.000Z" });
  const files = ["a", "b"].map(name => { const file = join(directory, `${name}.html`); writeFileSync(file, page); return file; });

  // The reason the start is memoized rather than guarded by a field set after an await. Two listeners would mean the
  // second won the port, and every link already handed out for the first would fail its own Host check.
  const [first, second] = await Promise.all(files.map(file => server.publish(file)));
  const port = (url: string) => new URL(url).port;
  assert.equal(port(first!), port(second!), "one listener, not two");
  assert.notEqual(port(first!), "0", "and a real port, never the zero a concurrent close would leave behind");
  assert.notEqual(first, second, "each report still gets its own name");
  for (const url of [first!, second!]) assert.equal((await fetch(url)).status, 200);

  // After close the names are forgotten, and the next report binds a fresh listener rather than reusing a dead memo.
  await server.close();
  assert.equal(server.port, 0);
  const third = await server.publish(files[0]!);
  assert.notEqual(port(third), port(first!), "a new listener, on a new port");
  assert.equal((await fetch(third)).status, 200);
  assert.equal((await fetch(`${new URL(third).origin}/r/${new URL(first!).pathname.slice(3)}`)).status, 404,
    "and a name minted before the close is not served by what came after it");
});
test("the report is reachable on loopback, and that link serves only reports this process wrote", async t => {
  const { ReportServer } = await import("../src/report-server.ts");
  const directory = mkdtempSync(join(tmpdir(), "astra-serve-"));
  const file = join(directory, "r.html");
  const server = new ReportServer();
  t.after(async () => { await server.close(); rmSync(directory, { recursive: true, force: true }); });
  writeFileSync(file, portfolioReport({ accounts: [account()], generatedAt: "2026-09-16T12:00:00.000Z" }));

  const url = await server.publish(file);
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/r\/[\w-]{12}$/, "loopback only, and an unguessable name");
  const page = await fetch(url);
  assert.equal(page.status, 200);
  const sent = page.headers.get("content-security-policy") ?? "";
  assert.match(sent, /default-src 'none'/);
  assert.match(sent, /frame-ancestors 'none'/);
  assert.equal(page.headers.get("cache-control"), "no-store");
  const body = await page.text();
  assert.match(body, /••••0000 individual/);

  // A browser enforces every policy it is given, so the header must permit exactly what the page pins. A header that
  // named no script-src would fall back to default-src 'none' and silently kill the print button — the page would
  // look right and the one control on it would do nothing.
  const pinned = body.match(/content="([^"]*script-src [^"]*)"/)?.[1] ?? "";
  assert.ok(pinned.includes("script-src 'sha256-"), "the page pins its script by hash");
  const hashOf = (policy: string) => policy.match(/script-src '(sha256-[^']+)'/)?.[1];
  assert.equal(hashOf(sent), hashOf(pinned), "and the header sends that same hash, not a stricter policy");
  assert.equal(hashOf(sent), `sha256-${createHash("sha256").update(body.match(/<script>([^<]*)<\/script>/)![1]!).digest("base64")}`,
    "which is the hash of the script actually in the page");

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
  const input = { accounts: [account(), account({ label: "••••1234 roth ira",
    totals: { value: 40000, cash: 0, byClass: [{ label: "Stocks", value: 40000 }] },
    holdings: [
      { holding: { symbol: "FIXA", shares: 10, averageCost: 200 }, levels: computed, series: { daily: series } },
      { holding: { symbol: "QUIET", shares: 5, averageCost: 10 }, unavailable: "no usable daily price history" },
    ] })], generatedAt: "2026-09-16T12:00:00.000Z" };
  const summary = overview(input);
  assert.equal(summary.asOf, "2026-09-16");
  assert.deepEqual(summary.accounts.map(a => [a.label, a.holdings]), [["••••0000 individual", 1], ["••••1234 roth ira", 2]]);
  assert.equal(summary.totalValue, 165340.55, "totals add up across the accounts");
  // Robinhood's payload carries no day change, so the overview no longer claims one.
  assert.ok(!("totalDayChange" in summary), "no figure is offered that the provider does not send");
  assert.deepEqual(summary.accounts[0]!.byClass, [{ label: "Stocks", value: 15294 }], "what the account is made of rides along");
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
