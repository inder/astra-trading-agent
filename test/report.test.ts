import { test } from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { levels, parseLevelsSettings, movingAverageSeries, type Analysis, type Gap, type Levels, type Zone } from "../src/levels.ts";
import { overview, portfolioReport, type ReportAccount } from "../src/report.ts";
import { TradingAgentService } from "../src/agent-service.ts";
import { syntheticBars } from "./levels-fixture.ts";

const bars = syntheticBars();
const computed = levels(bars, parseLevelsSettings());
const series = bars.time.map((time, i) => ({ time, value: bars.close[i]! }));
const account = (over: Partial<ReportAccount> = {}): ReportAccount => ({
  label: "••••0000 individual",
  totals: { value: 125340.55, cash: 2200, byClass: [{ label: "Stocks", value: 15294 }] },
  holdings: [{ symbol: "FIXA", holding: { symbol: "FIXA", shares: 120, averageCost: 41.22 }, levels: computed, series: { daily: series } }],
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
  // One vocabulary for the count, everywhere it appears. A zone that has NOT been broken reports it; a zone the
  // price closed up through does not, because after a flip `tests` is recomputed under the side the zone is on now
  // and counts the years it spent turning the price back as it having held as support. The shared fixture happens
  // to contain breaks, so the count is asserted on a zone with none.
  const quiet = { ...computed, frames: computed.frames.map(f => ({ ...f,
    support: (f.support ?? []).map(({ broke, ...z }) => z), resistance: (f.resistance ?? []).map(({ broke, ...z }) => z) })) };
  const quietHtml = portfolioReport({ accounts: [account({ holdings: [{ symbol: "FIXA",
    holding: { symbol: "FIXA", shares: 120, averageCost: 41.22 }, levels: quiet, series: { daily: series } }] })],
    generatedAt: "2026-09-16T12:00:00.000Z" });
  assert.match(quietHtml, /held \d+</, "a zone says how often it held, in one word used everywhere");
  assert.ok(!/\d+ tests|\d+×/.test(html), "and never in a second vocabulary");
  // And where it HAS been broken, the count is replaced rather than sitting beside a break date, where it would
  // read as "held as support 11 times since Aug 11" — which is false.
  assert.match(html, /above it since [A-Z][a-z]{2} \d+, \d{4}/);
  assert.ok(!/held \d+ · above it since|above it since [^<]*held/.test(html), "the two never appear together");
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
  // The heading names WHOSE price the axis carries. "Price, cost and levels" was ambiguous the moment a group could
  // hold options and no shares — a contract's own price is its premium, which never goes on this axis.
  assert.match(html, /<details class="technicals"><summary>Underlying price, levels, your share cost/,
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
  // An `xmlns` is a namespace identifier, never fetched — including inside the percent-encoded data URI the
  // favicon rides in, where the quotes around it are %22. Strip both spellings, then the assertion is about real
  // network references and nothing else.
  const noNamespaces = html.replace(/xmlns=(?:"[^"]*"|%22[^%]*%22)/g, "");
  assert.ok(!/https?:\/\//.test(noNamespaces), "nothing is fetched");
  assert.match(html, /<link rel="icon" href="data:image\/svg\+xml,/, "and the icon travels with the page");
});

test("no chart label is written outside its own chart, however crowded the chart is", () => {
  // The two assertions above — labels fit horizontally, labels stay apart vertically — were both satisfiable by a
  // label placed BELOW the chart, where nothing draws it at all. An SVG does not clip or complain; the text is
  // simply not there, and its band's price goes with it. Measured on a real report: four labels in a 380-high
  // viewBox were written at y=383.3 and y=396.3.
  //
  // Six zones packed into a few cents force it: the placer clamped where its search started and then nudged
  // downward with no bound, so each collision walked the next label further past the floor.
  const zone = (i: number, lo: number): Zone =>
    ({ id: `z${i}`, lo, hi: lo + 0.04, tests: 20 + i, last: "2026-09-15", members: [] });
  const crowded = {
    ...computed,
    frames: computed.frames.map(f => ({ ...f,
      support: [zone(1, 41.00), zone(2, 41.05), zone(3, 41.10)],
      resistance: [zone(4, 41.15), zone(5, 41.20), zone(6, 41.25)] })),
  };
  const html = portfolioReport({ accounts: [account({ holdings: [
    { symbol: "TIGHT", holding: { symbol: "TIGHT", shares: 100, averageCost: 41.1 }, levels: crowded, series: { daily: series } }] })],
    generatedAt: "2026-09-16T12:00:00.000Z" });

  const charts = [...html.matchAll(/<svg class="chart"[^>]*viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"[\s\S]*?<\/svg>/g)];
  assert.ok(charts.length, "there are charts to check");
  let checked = 0;
  for (const [svg, , height] of charts) {
    for (const m of svg.matchAll(/<text[^>]*\by="(-?[\d.]+)"/g)) {
      const y = Number(m[1]); checked++;
      assert.ok(y >= 0 && y <= Number(height), `a label at y=${y} is outside a ${height}-high chart, so it is not drawn`);
    }
  }
  assert.ok(checked > 20, `${checked} labels were checked, which is too few to have exercised the crowding`);
});
test("a holding without levels still appears, saying why, rather than being dropped", () => {
  const html = portfolioReport({ accounts: [account({
    holdings: [{ symbol: "QUIET", holding: { symbol: "QUIET", shares: 5, averageCost: null }, unavailable: "no usable daily price history from Robinhood" }],
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
    holdings: [{ symbol: "A&B<C", holding: { symbol: "A&B<C", shares: 1, averageCost: 1 }, unavailable: "<img src=x onerror=alert(1)>" }],
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
  assert.match(optionsOnly, /This account holds no stocks\. Counted in the account value above, but not listed here: options \(\$99,000\)\./);
  assert.ok(!/&#39;s stocks\./.test(optionsOnly), "and it does not describe stocks it does not have");
  assert.match(optionsOnly, /<dt>Options<\/dt><dd>\$99,000<\/dd>/, "the value is still stated");
  assert.ok(!/<dt>Stocks<\/dt>/.test(optionsOnly), "with no stocks line invented for it");
  assert.ok(!/<thead>/.test(optionsOnly), "and no empty table: eight column headers over nothing read as a failure");
  // The note must not send the reader to a table that was suppressed. It said "so the table below is empty" while
  // rendering no table at all — pointing at something not on the page, which is worse than saying nothing.
  assert.ok(!/table below/.test(optionsOnly), "and it names no table, because there is none to name");

  // An empty holdings list is not evidence of an empty account: it is also what every row failing to parse produces.
  // Claiming "holds no stocks" in the same paragraph that says rows were dropped states two different things as one.
  const allDropped = portfolioReport({ accounts: [account({ holdings: [], skipped: 7, totals: {
    value: 100000, cash: 1000, byClass: [{ label: "Options", value: 99000 }] } })], generatedAt: "2026-09-16T12:00:00.000Z" });
  assert.match(allDropped, /No positions could be read for this account, so none are listed\./);
  assert.ok(!/holds no stocks/.test(allDropped), "an unreadable book is not an empty one");

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

  assert.match(withOptions({ count: 12, positions: 12, skipped: 0, truncated: false }), /options \(\$470,000, 12 open contracts\)/);
  assert.match(withOptions({ count: 1, positions: 1, skipped: 0, truncated: false }), /1 open contract\)/, "and it counts in English");
  assert.match(withOptions("unreadable"), /options \(\$470,000, the contracts behind it could not be read\)/,
    "a read that failed is not an account that holds nothing");
  assert.match(withOptions({ count: 0, positions: 0, skipped: 40, truncated: false }), /none of its 40 contract rows could be read/,
    "and neither is a payload whose every row was dropped — the shape-drift case");
  // No rows, nothing dropped, and an account worth $470,000 in options: the provider disagreeing with itself. This
  // is the shape a payload wrapper Astra does not know about produces, and the last state that could still have been
  // reported as a fact — "0 open contracts" takes one side of a contradiction and states it.
  assert.match(withOptions({ count: 0, positions: 0, skipped: 0, truncated: false }), /no contract rows came back for it/);
  assert.ok(!/0 open contracts/.test(withOptions({ count: 0, positions: 0, skipped: 0, truncated: false })));
  assert.match(withOptions({ count: 20, positions: 20, skipped: 0, truncated: true }), /20\+ open contracts, more than one report can page through/,
    "a count that stopped early says so rather than looking authoritative");
  assert.match(withOptions({ count: 12, positions: 12, skipped: 3, truncated: false }), /12 open contracts, and 3 rows that could not be read/);
  // Nothing known at all — the options figure stands alone rather than gaining a claim about its contracts.
  assert.match(withOptions(undefined), /options \(\$470,000\)/);

  // Contracts and the rows they arrived in are different numbers, and the page says "contracts". Counting rows
  // reported a four-contract position as "1 open contract" — a wrong number beside a real dollar figure.
  assert.match(withOptions({ count: 4, positions: 1, skipped: 0, truncated: false }),
    /4 open contracts across 1 position\b/, "four contracts in one row is four contracts");
  assert.match(withOptions({ count: 7, positions: 3, skipped: 0, truncated: false }), /7 open contracts across 3 positions/);
  // The rows are named only when they differ from the contracts; "3 contracts across 3 positions" is noise.
  // Scoped to the options sentence rather than the whole document: the page carries prose elsewhere, and a bare
  // word match against all of it fails for reasons that have nothing to do with this claim.
  const note = (h: string) => h.match(/options \(\$[\d,]+, ([^)]*)\)/)?.[1] ?? "";
  assert.ok(!/across/.test(note(withOptions({ count: 3, positions: 3, skipped: 0, truncated: false }))));
});

test("a short options book is not reported as no options", () => {
  // The provider-disagreement sentence was gated on `value > 0`, so it fired only for accounts whose options were
  // worth something POSITIVE. A written book's options value is negative, and an offsetting one is near zero —
  // so the two accounts most likely to be misread were the two the check let through in silence.
  const book = (value: number, options: ReportAccount["options"]) => portfolioReport({ accounts: [account({
    holdings: [], options, totals: { value: 50000, cash: 52000, byClass: [{ label: "Options", value }] } })],
    generatedAt: "2026-09-16T12:00:00.000Z" });

  assert.match(book(-2400, { count: 0, positions: 0, skipped: 0, truncated: false }), /no contract rows came back for it/,
    "a negative options figure with no rows is the same contradiction as a positive one");
  assert.match(book(-2400, { count: 6, positions: 2, skipped: 0, truncated: false }), /6 open contracts across 2 positions/,
    "and a short book that did read is described by its contracts, not by the sign of its value");
  // A long and a short that cancel: the figure rounds to nothing while two contracts stand open. The count governs,
  // and nothing here says the account holds no options.
  const offsetting = book(0, { count: 2, positions: 2, skipped: 0, truncated: false });
  assert.ok(!/no contract rows|holds no options/.test(offsetting), "an offsetting book is not an empty one");
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
    holdings: [{ symbol: "NEWCO", holding: { symbol: "NEWCO", shares: 100, averageCost: 40 }, levels: thin, series: { daily: series } }],
  })], generatedAt: "2026-09-16T12:00:00.000Z" };
  const html = portfolioReport(input);
  assert.ok(!/\$0\.00/.test(html), "no zero price reaches the table");
  assert.ok(!/−100\.0%/.test(html), "and no total loss is invented");
  assert.match(html, /only \d+ sessions of history/, "the reason is on the page, not only in the tool's JSON");
  // The warning sits beside the row rather than inside the collapsed disclosure, which print drops when unopened.
  const beforeDetails = html.slice(0, html.indexOf("<details"));
  assert.match(beforeDetails, /only \d+ sessions of history/, "and is visible without expanding anything");
  const view = overview(input);
  assert.ok(!view.largestLosses.some(w => w.symbol === "NEWCO" && w.gainPct <= -99), "the chat is not told it lost everything");
});
test("a price that is not a closing price is never shown as one", () => {
  // The case from 2026-09-16: Robinhood had not published that day's daily bar hours after the close, so the newest
  // trade was an after-hours print. Shown under a column headed "Last close", it read as the day's close.
  const afterHours = { ...computed, priceSource: "after-hours" as const, priceAt: "2026-09-16T21:42:00.000Z" };
  const html = portfolioReport({ accounts: [account({
    holdings: [{ symbol: "FIXA", holding: { symbol: "FIXA", shares: 120, averageCost: 41.22 }, levels: afterHours, series: { daily: series } }],
  })], generatedAt: "2026-09-16T23:36:00.000Z" });
  // \s, not a literal space: ICU separates the time from AM/PM with U+202F, a narrow no-break space.
  assert.match(html, /after hours Sep 16, 5:42\sPM ET/, "it says what it is, and when, in the market's own timezone");
  assert.ok(!/Last close/.test(html), "and never under a heading that calls it a close");
  assert.match(html, /after hours<\/text>/, "the chart's own price line says so too");
  // The levels themselves still come from the last settled session, whatever the price is.
  assert.match(html, new RegExp(`${computed.frames.find(f => !f.unavailable)!.label}`), "frames are unchanged");

  const preMarket = { ...computed, priceSource: "pre-market" as const, priceAt: "2026-09-16T12:10:00.000Z" };
  const early = portfolioReport({ accounts: [account({
    holdings: [{ symbol: "FIXA", holding: { symbol: "FIXA", shares: 120, averageCost: 41.22 }, levels: preMarket, series: { daily: series } }],
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
      { symbol: "FIXA", holding: { symbol: "FIXA", shares: 10, averageCost: 200 }, levels: computed, series: { daily: series } },
      { symbol: "QUIET", holding: { symbol: "QUIET", shares: 5, averageCost: 10 }, unavailable: "no usable daily price history" },
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
  assert.ok(summary.largestGains.length && summary.largestGains.every((g, i, all) => i === 0 || g.gainPct <= all[i - 1]!.gainPct), "the ranking runs downward");
  assert.ok(!summary.largestLosses.some(w => summary.largestGains.some(b => b.symbol === w.symbol)),
    "with only a couple of holdings, the gains list covers them and the losses list repeats nothing");
  // Small enough to narrate: this is a paragraph's worth of facts, not the report.
  assert.ok(JSON.stringify(summary).length < 1200, `${JSON.stringify(summary).length} bytes`);
});
test("the moving-average series the chart could draw matches the numbers the report states", () => {
  // Guards the rule the whole design rests on: a picture is a view of the same answer, never a second computation.
  const drawn = movingAverageSeries(bars, [10]).at(0)!.points.at(-1)!.value;
  assert.ok(Math.abs(drawn - computed.averages.find(a => a.period === 10)!.value!) < 1e-9);
});

const contract = (over: Partial<import("../src/report.ts").ReportContract> = {}) => ({
  expiry: "2026-12-18", contracts: 4, direction: "long" as const, right: "call" as const,
  strike: 44, multiplier: 100, averageCostPerShare: 6.2, mark: 7.85, markAt: "2026-09-18T20:02:00.000Z",
  value: { value: 3140, basis: 2480, gain: 660, gainPctOfPremium: 26.6 }, ...over,
} as import("../src/report.ts").ReportContract);

test("an account that holds only options is not an empty report", () => {
  // The founder opened a report, pointed at an account holding options and nothing else, and said: "this account is
  // options only, and it shows nothing." It had a value, a contract count, and no listing.
  const html = portfolioReport({ accounts: [account({
    totals: { value: 5266, cash: 2666, byClass: [{ label: "Options", value: 2600 }] },
    holdings: [{ symbol: "FIXA", levels: computed, series: { daily: series }, contracts: [contract()] }],
    options: { count: 4, positions: 1, skipped: 0, truncated: false },
  })], generatedAt: "2026-09-16T12:00:00.000Z" });

  // Everything a holder needs, without opening anything: which way round, how many, call or put, the full
  // expiration, the strike, what was paid, the mark and its time, the signed value and the gain.
  assert.match(html, /FIXA Dec 18, 2026 \$44\.00 call · long/, "the contract names itself in full");
  assert.match(html, /<tr class="contract">/);
  assert.match(html, /\$7\.85<span class="dist">mark Sep 18, 4:02 PM ET/, "the mark carries its own clock");
  assert.match(html, /\$3,140/); assert.match(html, /26\.6% of premium/,
    "and a percentage names its denominator, which is neither collateral nor capital");

  // The underlying's own price and levels have somewhere to live. A contract's Price column is its PREMIUM, so the
  // stock price cannot go there — with no share row there was previously nowhere for it at all.
  assert.match(html, /<span class="dist">no shares<\/span>/, "the group says it holds no shares rather than showing a dash");
  assert.match(html, /close [A-Z][a-z]{2} \d+, \d{4}/, "the underlying's price is still stated, with its session");
  assert.match(html, /Support below/);

  // And the note no longer names options among the things that are NOT listed, because they are listed.
  assert.match(html, /The table below lists this account&#39;s option contracts\./);
  assert.ok(!/not listed here: options/.test(html), "options are on the page now, so nothing says they are absent");
  assert.ok(!/holds no stocks, so the table below is empty/.test(html));
});

test("a group carries its shares and its contracts, and the money is signed", () => {
  const html = portfolioReport({ accounts: [account({
    totals: { value: 125340.55, cash: 2200, byClass: [{ label: "Stocks", value: 15294 }, { label: "Options", value: 2660 }] },
    holdings: [{ symbol: "FIXA", holding: { symbol: "FIXA", shares: 120, averageCost: 41.22 },
      levels: computed, series: { daily: series }, contracts: [
        contract(),
        // A short put. Its value must be negative in the group's total, or the account is overstated by twice the
        // premium — which is what "invert the P&L for a short" alone would have produced.
        contract({ direction: "short", right: "put", strike: 38, contracts: 2, averageCostPerShare: 3.1, mark: 2.4,
          value: { value: -480, basis: -620, gain: 140, gainPctOfPremium: 22.6 } }),
      ] }],
  })], generatedAt: "2026-09-16T12:00:00.000Z" });

  assert.match(html, /FIXA Dec 18, 2026 \$38\.00 put · short/, "the direction survives the merge with the instrument");
  assert.match(html, /−\$480/, "a written contract subtracts from the group");
  // The group's value is the shares plus every contract that could be valued, signed.
  const shares = 120 * computed.price;
  assert.ok(html.includes(`$${Math.round(shares + 3140 - 480).toLocaleString("en-US")}`),
    `the group totals ${Math.round(shares + 3140 - 480)}`);
  // No percentage on a mixed group: premium and share cost are different denominators, and one number over both
  // would mean nothing. The dollar figure is still there.
  const groupRow = html.match(/<tr class="holding[^"]*">[\s\S]*?<\/tr>/)![0];
  assert.ok(!/% *<\/span>/.test(groupRow.split("Support")[0] ?? ""), "no percentage is claimed across two denominators");
  assert.match(html, /The table below lists this account&#39;s stocks and option contracts\./);
});

test("a contract whose terms could not be read is listed anyway, and never at a strike of zero", () => {
  const html = portfolioReport({ accounts: [account({
    holdings: [{ symbol: "FIXA", levels: computed, series: { daily: series }, contracts: [
      contract({ right: null, strike: null, mark: null, markAt: null, value: null,
        note: "the provider did not return this contract's terms" }),
      contract({ right: null, strike: null, mark: null, markAt: null, value: null, contracts: 1,
        note: "terms not fetched within this report's limit" }),
    ] }],
  })], generatedAt: "2026-09-16T12:00:00.000Z" });

  assert.match(html, /FIXA Dec 18, 2026 contract · long/, "named from what the position already knew");
  assert.ok(!/\$0\.00 call|\$0\.00 put/.test(html), "never a strike of zero");
  // The two absences are different facts and get different words: one is the provider declining to answer, the
  // other is this report declining to ask.
  assert.match(html, /the provider did not return this contract&#39;s terms/);
  assert.match(html, /terms not fetched within this report&#39;s limit/);
});

test("a strike is drawn once per distinct price, and a far one does not flatten the chart", () => {
  const strike = Math.round(computed.price * 1.04 * 100) / 100;
  const far = Math.round(computed.price * 3.2);
  const html = portfolioReport({ accounts: [account({
    holdings: [{ symbol: "FIXA", levels: computed, series: { daily: series }, contracts: [
      contract({ strike }),
      // Same strike, different expiry: one marker, both contracts named on it. Two lines at one price is just a
      // thicker line, and a label reading only "$44.00" would not say which contracts it belongs to.
      contract({ strike, expiry: "2027-01-15", contracts: 1 }),
      contract({ strike: far, expiry: "2027-06-18", contracts: 1 }),
      // An adjusted deliverable: the strike is real and is shown in the row, but it is not comparable to the share
      // price, so it is not drawn against that axis.
      contract({ strike: 5, expiry: "2026-10-16", strikeNotDrawn: "it trades in the FIXA1 chain, not FIXA" }),
    ] }],
  })], generatedAt: "2026-09-16T12:00:00.000Z" });

  const pane = html.match(/<svg class="chart"[\s\S]*?<\/svg>/)![0];
  const markers = [...pane.matchAll(/<g class="strike">/g)].length;
  assert.equal(markers, 2, `one marker per distinct drawable strike, got ${markers}`);
  assert.ok(pane.includes(`$${strike.toFixed(2)} strike · 4× Dec 18, 2026 call long, 1× Jan 15, 2027 call long`),
    "and it names every contract standing behind it");
  assert.ok(!/FIXA1 chain[\s\S]*<\/svg>/.test(pane), "an adjusted contract's strike is not drawn");
  assert.match(html, /strike \$5\.00 is [\d.]+% below the price · not drawn: it trades in the FIXA1 chain/,
    "but the row still states it, and says why the chart does not");
  // A far strike is clamped and labelled, never admitted to the domain — a $408 strike on a $127 stock would
  // otherwise compress the whole price history into a line at the bottom edge.
  assert.match(pane, /strike · 1× Jun 18, 2027 call long \(off scale\)/);
  const line = pane.match(/<path class="line" d="([^"]+)"/)![1]!;
  const ys = [...line.matchAll(/[ML][\d.]+ ([\d.]+)/g)].map(m => Number(m[1]));
  assert.ok(Math.max(...ys) - Math.min(...ys) > 100,
    `the price history still uses the chart: it spans ${(Math.max(...ys) - Math.min(...ys)).toFixed(0)} of 380`);
  // A distance is a magnitude with a direction in words. "+7.0% below" reads as a contradiction.
  assert.ok(!/[+−]\d+\.\d% (above|below) the price/.test(html), "no signed percentage sits in front of above/below");
});

test("a group total covers every contract in it, or says it is unknown", () => {
  // The oldest defect on this project wearing new clothes. Summing only the contracts that COULD be valued makes an
  // empty list total zero, so a group of shares plus contracts nobody could price printed the share figure alone —
  // identical on the page to a group whose contracts are worth nothing, and short by whatever they are worth. This
  // is how overview() once reported a portfolio short by an entire account, by treating a null total as a zero.
  const shares = 120 * computed.price;
  const withUnvalued = portfolioReport({ accounts: [account({
    holdings: [{ symbol: "FIXA", holding: { symbol: "FIXA", shares: 120, averageCost: 41.22 },
      levels: computed, series: { daily: series },
      contracts: [contract({ mark: null, markAt: null, value: null })] }],
  })], generatedAt: "2026-09-16T12:00:00.000Z" });
  const groupRow = withUnvalued.match(/<tr class="holding[^"]*">[\s\S]*?<\/tr>/)![0];
  assert.ok(!groupRow.includes(`$${Math.round(shares).toLocaleString("en-US")}`),
    "the share figure alone is not the group's value when a contract could not be priced");
  assert.match(groupRow, /<td class="num">—/, "an unknown total is a dash, not a number that omits a part");
  assert.match(groupRow, /1 of 1 contract not priced/, "and the dash says why, on the line the dash is on");

  // The same group with every contract valued does state a total — the rule is completeness, not pessimism.
  const allValued = portfolioReport({ accounts: [account({
    holdings: [{ symbol: "FIXA", holding: { symbol: "FIXA", shares: 120, averageCost: 41.22 },
      levels: computed, series: { daily: series }, contracts: [contract()] }],
  })], generatedAt: "2026-09-16T12:00:00.000Z" });
  assert.ok(allValued.includes(`$${Math.round(shares + 3140).toLocaleString("en-US")}`),
    "with every contract priced, the group totals shares plus contracts");

  // Partial valuation is the same failure with a subtler face: two priced and one not must not total the two.
  const partial = portfolioReport({ accounts: [account({
    holdings: [{ symbol: "FIXA", levels: computed, series: { daily: series }, contracts: [
      contract(), contract({ expiry: "2027-01-15" }),
      contract({ expiry: "2027-06-18", mark: null, markAt: null, value: null }),
    ] }],
  })], generatedAt: "2026-09-16T12:00:00.000Z" });
  assert.ok(!partial.includes("$6,280"), "two priced contracts are not the total of three");
});

test("listing the contracts does not lose the warning that the list is incomplete", () => {
  // Taking the options class out of the "not listed here" sentence took the truncated and skipped clauses with it —
  // they were only ever reachable through optionNote(), which is only called for classes in that sentence. The
  // reader would then see N rows and take them for the whole book, which is worse than the bare count this replaced:
  // rows look complete in a way a number does not.
  const listed = (options: ReportAccount["options"]) => portfolioReport({ accounts: [account({
    options,
    totals: { value: 50000, cash: 1000, byClass: [{ label: "Options", value: 2600 }] },
    holdings: [{ symbol: "FIXA", levels: computed, series: { daily: series }, contracts: [contract()] }],
  })], generatedAt: "2026-09-16T12:00:00.000Z" });

  assert.match(listed({ count: 40, positions: 20, skipped: 0, truncated: true }),
    /more contracts than one report can page through/, "a book that stopped early says so beside the rows");
  assert.match(listed({ count: 4, positions: 1, skipped: 3, truncated: false }),
    /3 contract rows could not be read and are not listed/, "and dropped rows are still counted out loud");
  // A complete book says neither, rather than hedging every report.
  const clean = listed({ count: 4, positions: 1, skipped: 0, truncated: false });
  assert.ok(!/page through|could not be read/.test(clean), "a complete book is not qualified");
});

test("a contract that cannot be valued says why, even when its terms are known", () => {
  // The reason was rendered only when the strike was missing, so a contract whose terms were found but whose
  // direction could not be read showed a dash in three money columns with nothing beside it — the shape this report
  // treats as a defect everywhere else.
  const html = portfolioReport({ accounts: [account({
    holdings: [{ symbol: "FIXA", levels: computed, series: { daily: series }, contracts: [
      contract({ direction: null, mark: null, markAt: null, value: null,
        note: "not valued: direction could not be read" }),
    ] }],
  })], generatedAt: "2026-09-16T12:00:00.000Z" });

  assert.match(html, /strike \$44\.00 is [\d.]+% below the price · not valued: direction could not be read/,
    "both facts are stated: where the strike sits, and why there is no value");
  assert.match(html, /FIXA Dec 18, 2026 \$44\.00 call\b/, "and the contract is still named by its terms");
  assert.ok(!/call · null|· long · short/.test(html), "with no direction invented for it");
});

test("the whole option path runs end to end: three reads, one group, a priced contract row", async t => {
  // The gap a re-review found. Every other integration test leaves `optionPositionsAvailable` falsy, so `contracts`
  // stays empty and the wiring between the three reads and the rendered row executes in NO test — the pieces are
  // unit-tested and the glue is not. That is where a mistake hides: every unit test passes and the page quietly
  // shows the wrong thing. It is also how the adjusted-contract guard stayed dead for three commits, green in a
  // unit test that hand-fed it a pair the production path never produces.
  const dataDirectory = mkdtempSync(join(tmpdir(), "astra-report-options-"));
  const barPayload = (symbol: string) => ({ data: { results: [{ symbol, interval: "day", bounds: "regular",
    bars: bars.time.map((t, i) => ({ begins_at: `${t}T00:00:00Z`, open_price: String(bars.open[i]), high_price: String(bars.high[i]),
      low_price: String(bars.low[i]), close_price: String(bars.close[i]), volume: "1000", session: "reg" })) }] } });
  const contractId = "3a4b5c6d-7e8f-4a1b-9c2d-0e1f2a3b4c5d";
  const shortId = "3a4b5c6d-7e8f-4a1b-9c2d-0e1f2a3b4c99";
  const reads: string[] = [];
  const asked: Record<string, unknown[]> = {};
  const broker = {
    accountRead: async (tool: string) => {
      reads.push(tool);
      if (tool === "get_accounts") return { data: { accounts: [{ account_number: "100000000", brokerage_account_type: "individual", is_default: true }] } };
      if (tool === "get_portfolio") return { data: { portfolio: { total_value: "60000", cash: "1000", equity_value: "50000", options_value: "9000" } } };
      if (tool === "get_option_positions") return { data: { positions: [
        // Captured shape: direction is `type`, quantity stays positive, the strike and right are NOT here.
        { option_id: contractId, chain_symbol: "FIXA", type: "long", quantity: "4.0000", average_price: "6.2000",
          expiration_date: "2026-12-18", trade_value_multiplier: "100.0000" },
        // A short on the same underlying, so the group's money has to carry a sign through the whole pipeline.
        { option_id: shortId, chain_symbol: "FIXA", type: "short", quantity: "2.0000", average_price: "3.1000",
          expiration_date: "2026-11-20", trade_value_multiplier: "100.0000" },
      ] } };
      return { data: { positions: [{ symbol: "FIXA", quantity: "120", average_buy_price: "41.22" }], next_cursor: null } };
    },
    read: async (tool: string, args: any) => {
      reads.push(tool);
      (asked[tool] ??= []).push(args);
      if (tool === "get_option_instruments") {
        const ids = String(args.ids).split(",");
        return { data: { instruments: ids.map(id => ({ id, chain_symbol: "FIXA", underlying_type: "equity",
          expiration_date: "2026-12-18", strike_price: id === shortId ? "38.0000" : "44.0000",
          type: id === shortId ? "put" : "call", state: "active", tradability: "tradable",
          trade_value_multiplier: "100.0000" })) } };
      }
      if (tool === "get_option_quotes") {
        return { data: { results: args.instrument_ids.map((id: string) => ({
          quote: { instrument_id: id, mark_price: id === shortId ? "2.4000" : "7.8500", updated_at: "2026-09-16T20:02:11.000Z" },
          close: { instrument_id: id, symbol: "FIXA", date: "2026-09-15", price: "7.4000", interpolated: false },
        })) } };
      }
      return barPayload(args.symbols[0]);
    },
    status: () => ({ state: "connected", accountListAvailable: true, accountToolsAvailable: true,
      optionPositionsAvailable: true, connectionId: "c1", paperDataAvailable: true }),
    close: async () => {},
  } as any;
  const service = new TradingAgentService(dataDirectory, undefined, broker,
    { ready: () => true, clock: () => Date.parse("2026-09-16T12:00:00Z"), auto: false });
  t.after(async () => { await service.close(); rmSync(dataDirectory, { recursive: true, force: true }); });

  const [chosen] = await service.accounts();
  const written = await service.portfolioReport([chosen!.handle]);
  const html = readFileSync(written.path, "utf8");

  // All three reads happened, and the shapes they were asked with are the ones the provider actually accepts —
  // which are NOT the same shape as each other, and inferring one from the other cost two live OAuth windows.
  for (const tool of ["get_option_positions", "get_option_instruments", "get_option_quotes"])
    assert.ok(reads.includes(tool), `${tool} was read`);
  assert.equal(typeof (asked["get_option_instruments"]![0] as any).ids, "string", "instruments take a comma string");
  assert.ok(Array.isArray((asked["get_option_quotes"]![0] as any).instrument_ids), "quotes take an array");

  // Shares and contracts merged into ONE group under their underlying, not three separate rows.
  assert.equal(written.holdings, 1, "one underlying, not one row per position");
  assert.equal((html.match(/<tr class="holding/g) ?? []).length, 1);
  assert.equal((html.match(/<tr class="contract">/g) ?? []).length, 2);

  // The long contract, priced from the live mark, with its own clock — not the underlying's.
  assert.match(html, /FIXA Dec 18, 2026 \$44\.00 call · long/);
  assert.match(html, /\$7\.85<span class="dist">mark Sep 16, 4:02 PM ET<\/span>/, "the mark carries its own timestamp");
  assert.match(html, /\$3,140/, "4 contracts × 100 × $7.85");

  // The short. Value negative, P&L positive (the mark fell from $3.10 to $2.40) — the sign has to survive the
  // instrument merge, where `type` means long/short on one object and call/put on the other.
  assert.match(html, /FIXA Nov 20, 2026 \$38\.00 put · short/, "direction survived the merge with the instrument");
  assert.match(html, /−\$480/, "a written contract is a liability: 2 × 100 × $2.40, negative");
  // Group total: shares + long − short, all valued, so a number rather than a dash.
  const shares = 120 * computed.price;
  assert.ok(html.includes(`$${Math.round(shares + 3140 - 480).toLocaleString("en-US")}`),
    `the group totals ${Math.round(shares + 3140 - 480)}`);
  assert.ok(!/contracts? not priced|not valued/.test(html), "nothing is unpriced in this fixture");

  // The strike is drawn against the underlying's own chart, once per distinct strike.
  assert.match(html, /<g class="strike">/);
  assert.match(html, /\$44\.00 strike · 4× Dec 18, 2026 call long/);
  assert.match(html, /\$38\.00 strike · 2× Nov 20, 2026 put short/);

  // The account note names what the table holds, and does not list options among things NOT listed.
  assert.match(html, /The table below lists this account&#39;s stocks and option contracts\./);
  assert.ok(!/not listed here: options/.test(html));
  // And nothing the provider sends that predicts an outcome reaches the page.
  for (const banned of ["chance_of_profit", "chance of profit", "break_even", "delta", "gamma", "vega", "theta", "rho"])
    assert.ok(!new RegExp(banned, "i").test(html), `${banned} must not reach the page`);
  assert.ok(!reads.some(r => /order|cancel|place|exercise/.test(r)), "and no tool that moves anything was called");
});

test("the report wears the product's own mark, and the copy cannot drift from the source", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const root = fileURLToPath(new URL("..", import.meta.url));
  const source = readFileSync(root + "docs/assets/astra-mark.svg", "utf8").trim();
  const html = portfolioReport({ accounts: [account()], generatedAt: "2026-09-16T12:00:00.000Z" });

  const href = html.match(/<link rel="icon" href="([^"]+)"/)?.[1];
  assert.ok(href, "the page links an icon");
  assert.ok(href!.startsWith("data:image/svg+xml,"), "carried in the page, not fetched");

  // The renderer holds its own copy of the mark because nothing in that module touches the filesystem — which is
  // what lets the whole report be exercised without one. The cost of that choice is two places to change, so this
  // is the check that makes the second one impossible to forget.
  const decoded = decodeURIComponent(href!.slice("data:image/svg+xml,".length));
  const shape = (s: string) => s.replace(/\s+/g, " ").trim();
  assert.equal(shape(decoded), shape(source),
    "src/report.ts's inlined mark no longer matches docs/assets/astra-mark.svg");

  // A saved page keeps its icon: the "Save this page" link hands the reader this exact file, and an icon fetched
  // from anywhere would be missing from precisely the copy someone keeps.
  assert.ok(!/href="[^"]*\.(svg|png|ico)"/.test(html), "no icon is referenced by path");
  // And the page's own policy would forbid fetching one anyway — `default-src 'none'` with `img-src data:`.
  const policy = html.match(/content-security-policy" content="([^"]+)"/)![1]!;
  assert.match(policy, /default-src 'none'/);
  assert.match(policy, /img-src data:/, "which is what makes a data-URI icon the only form that works");
});

// ── Breakouts on the page (B2+B3) ─────────────────────────────────────────────────────────────────────────────
/** Levels with the zones on one side replaced, so a cell state can be built without reverse-engineering bars. */
const withZones = (over: { support?: Zone[]; resistance?: Zone[]; overhead?: Analysis["overhead"];
  gaps?: Gap[]; price?: number }) => {
  const frames = computed.frames.map(f => ({ ...f,
    ...(over.support ? { support: over.support } : {}),
    ...(over.resistance !== undefined ? { resistance: over.resistance } : {}),
    ...(over.gaps ? { gaps: over.gaps } : {}),
    overhead: over.overhead ?? { zones: (over.resistance ?? f.resistance ?? []).length, gaps: 0, line: false } }));
  return { ...computed, ...(over.price ? { price: over.price } : {}), frames };
};
const zoneAt = (lo: number, hi: number, tests: number, broke?: Zone["broke"]): Zone =>
  ({ id: "Z1", lo, hi, tests, last: "2026-09-15", members: [], ...(broke ? { broke } : {}) });
const render = (levels: Levels) => portfolioReport({ accounts: [account({ holdings: [{ symbol: "FIXA",
  holding: { symbol: "FIXA", shares: 120, averageCost: 41.22 }, levels, series: { daily: series } }] })],
  generatedAt: "2026-09-16T12:00:00.000Z" });
/** The two level cells of the first holding row, as text. */
const levelCells = (html: string) => [...html.matchAll(/<td class="level">([\s\S]*?)<\/td>/g)]
  .slice(0, 2).map(m => m[1]!.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/\s+/g, " ").trim());

test("a stock that broke out and still has a ceiling says both, and joins them with nothing", () => {
  // The founder, on the case that prompted the feature: "INTC is interesting case. It broke out of range but it
  // still has resistance above. How you express that would be interesting."
  //
  // This is neither of the two shapes the design was first written around — a flipped zone beneath, or clear air
  // above. It is both halves of one pair, and almost certainly the common one, since a stock clearing one ceiling
  // usually has another. The two cells carry it; no sentence joins them, because "broke out but still capped" is a
  // characterization of a situation rather than a measurement.
  const html = render(withZones({
    support: [zoneAt(106, 107.4, 3, { direction: "above", on: "2026-09-03", closes: 9, barsSince: 8,
      recent: true, testsBefore: 14 })],
    resistance: [zoneAt(112, 114, 9)],
  }));
  const [below, above] = levelCells(html);
  assert.match(below!, /\$106\.00–107\.40 .* above it since Sep 3, 2026/, "what it broke, and when");
  assert.match(above!, /\$112\.00–114\.00 .* held 9/, "and what still stands over it");
  // Nothing characterizes the pair. A reader assembles two facts; the page does not assemble them for him.
  for (const editorial of ["but still", "however", "despite", "although", "capped", "room to", "clear to"])
    assert.ok(!new RegExp(editorial, "i").test(html), `the page does not say "${editorial}"`);
});

test("nothing above the price is a fact, not an em-dash", () => {
  // An em-dash is this report's character for *unknown*, and a stock at the top of its range is not unknown. Worse,
  // a dash made "above every high in this window" and "levels could not be computed" byte-identical in the column.
  const clear = render(withZones({ resistance: [], overhead: { zones: 0, gaps: 0, line: false } }));
  const [, above] = levelCells(clear);
  assert.match(above!, /no zone above/);
  assert.match(above!, /no prior high in this window/,
    "scoped to the window, because a longer tab may legitimately show a band overhead");
  assert.ok(!above!.includes("—"), "and never a bare dash");

  // "Prior" is load-bearing: the count excludes zones built only from the last few bars' highs, because on the day
  // a stock makes a new high its own session high sits just overhead. The claim is about what came before.
  assert.ok(/prior/.test(above!), "the word carries the exclusion, and is not decoration");

  // A cell claiming clear air while the chart visibly draws a gap would be the page disagreeing with itself.
  const gapped = render(withZones({ resistance: [], overhead: { zones: 0, gaps: 1, line: false },
    gaps: [{ side: "resistance", from: "2026-08-01", lo: 131.2, hi: 133.75 }] }));
  assert.match(levelCells(gapped)[1]!, /no zone above\s*an open gap at \$131\.20–133\.75/);
});

test("levels that could not be computed say so, where the absence of a zone used to look the same", () => {
  const broken: Levels = { ...computed, defaultTimeframe: null,
    frames: computed.frames.map(f => ({ ...f, support: undefined, resistance: undefined, unavailable: "only 14 sessions in this window; needs 20" })) };
  const [below, above] = levelCells(render(broken));
  assert.match(above!, /levels unavailable/, "not a dash, which reads as a stock with nothing overhead");
  assert.ok(!above!.includes("—"));
  assert.match(below!, /none in this window/, "and below the price, an absence is just an absence");
});

test("a flipped zone stops claiming it held, because that number is the other side's", () => {
  // After a flip, `tests` is recomputed under the side the zone is on NOW — so a level's years of turning the price
  // back are counted as it having "held" as support. Printed beside a break date it reads as "held as support 14
  // times since Sep 3", which is false. The count is replaced, not supplemented.
  const html = render(withZones({ support: [zoneAt(106, 107.4, 14,
    { direction: "above", on: "2026-09-03", closes: 9, barsSince: 8, recent: true, testsBefore: 14 })] }));
  const [below] = levelCells(html);
  assert.match(below!, /above it since Sep 3, 2026/);
  assert.ok(!/held 14/.test(below!), "the count that is no longer about this side is gone");

  // A break the price has given back says that instead, and does not read as still being above it.
  const given = render(withZones({ resistance: [zoneAt(112, 114, 9,
    { direction: "above", on: "2026-08-01", closes: 6, barsSince: 20, recent: true, testsBefore: 7,
      backInsideOn: "2026-09-12" })] }));
  assert.match(levelCells(given)[1]!, /back inside since Sep 12, 2026/);
  assert.ok(!/above it since/.test(levelCells(given)[1]!));

  // And a break too old to be worth saying keeps its date in the data while the cell returns to the count.
  const stale = render(withZones({ support: [zoneAt(106, 107.4, 14,
    { direction: "above", on: "2025-01-03", closes: 200, barsSince: 200, recent: false, testsBefore: 14 })] }));
  assert.match(levelCells(stale)[0]!, /held 14/, "an old break is history, and the cell says what the zone is now");
});

test("no break badge is added beside the symbol", () => {
  // The spec proposed one. It is cut, and this pins the decision rather than leaving it to memory.
  //
  // The level columns are right-aligned and six columns away, so a pill beside the symbol is what a skimming reader
  // sees while the ceiling above the price sits where they may not look. Choosing which of two adjacent true facts
  // gets the pill is an editorial act — and on the common shape, a stock that broke out and still has resistance
  // overhead, it would select the encouraging half.
  const html = render(withZones({
    support: [zoneAt(106, 107.4, 3, { direction: "above", on: "2026-09-03", closes: 9, barsSince: 8, recent: true, testsBefore: 14 })],
    resistance: [zoneAt(112, 114, 9)],
  }));
  const header = html.match(/<th scope="row">([\s\S]*?)<\/th>/)![1]!;
  assert.ok(!/broke/i.test(header), "the row header names the stock, and does not caption it");
  assert.equal((html.match(/class="flag"/g) ?? []).length <= 1, true, "at most the one flag that already existed");
});

test("rows are alphabetical, because ordering by nearness is a claim about what matters", () => {
  // A zone the price just closed through is, by construction, a fraction of an average day's range away — so under
  // proximity ordering every fresh break sorted itself to the top and lit the "near" styling. Naming breaks in
  // words would have turned a latent scanner into a captioned one, with the page explaining why its top row was on
  // top. The distances are still in the cells; only the page's opinion about reading order is gone.
  const holding = (symbol: string, levels: Levels) => ({ symbol,
    holding: { symbol, shares: 10, averageCost: 10 }, levels, series: { daily: series } });
  const far = withZones({ support: [zoneAt(80, 81, 5)], resistance: [zoneAt(200, 201, 5)] });
  const onTop = withZones({ support: [zoneAt(127.3, 127.4, 5)], resistance: [zoneAt(127.5, 127.6, 5)] });
  const html = portfolioReport({ accounts: [account({ holdings: [
    holding("ZETA", onTop), holding("ALFA", far)] })], generatedAt: "2026-09-16T12:00:00.000Z" });
  assert.ok(html.indexOf(">ALFA") < html.indexOf(">ZETA"),
    "alphabetical, even though ZETA sits on a level and ALFA does not");
});

test("the chart marks the session a zone was broken, and never a session it does not contain", () => {
  const html = render(withZones({ support: [zoneAt(106, 107.4, 3,
    { direction: "above", on: series[Math.floor(series.length * 0.8)]!.time, closes: 9, barsSince: 8, recent: true, testsBefore: 14 })] }));
  // Across the panes, not the first one: each timeframe draws its own slice, and a break inside the two-year
  // window legitimately predates the quarter-to-date one. A pane that does not reach the session does not draw it,
  // which is the property under test on the next assertion.
  assert.match(html, /<line class="broke"/, "a hairline where the close went through");
  const panes = [...html.matchAll(/<svg class="chart"[\s\S]*?<\/svg>/g)].map(m => m[0]);
  assert.ok(panes.some(p => /<line class="broke"/.test(p)) && panes.some(p => !/<line class="broke"/.test(p)),
    "drawn where the frame reaches the session, absent where it does not");

  // A break dated outside this frame's slice is NOT drawn at the window's edge. Clamping a missing index to zero —
  // which is what the gap renderer does — would state a false position confidently.
  // Both sides replaced: the shared fixture's own resistance zones carry real, in-window breaks, and leaving them
  // in draws hairlines that have nothing to do with the zone under test — which is how this assertion first
  // appeared to fail against correct code.
  const outside = render(withZones({ resistance: [], overhead: { zones: 0, gaps: 0, line: false },
    support: [zoneAt(106, 107.4, 3,
      { direction: "above", on: "2019-01-02", closes: 9, barsSince: 8, recent: true, testsBefore: 14 })] }));
  assert.ok(!/<line class="broke"/.test(outside), "a break this frame does not reach is simply not drawn");

  // The date does not go on the band label: PAD_R is sized from the label this chart will actually draw, and a
  // longer one is written past the viewBox and silently lost.
  assert.ok(!/class="s"[^>]*>[\s\S]{0,200}since /.test(panes[0] ?? ""), "the band label is unchanged");
});
