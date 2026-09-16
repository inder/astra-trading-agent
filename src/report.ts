// The portfolio report: one self-contained HTML page, meant to be read on screen and printed.
//
// Charts are inline SVG rather than a charting library. Printing is the binding constraint: a canvas chart needs
// ~600 KB of inlined JavaScript per page and prints badly, while an SVG per holding is a few kilobytes, needs no
// script at all, and comes out of "save as PDF" exactly as it looks.
//
// Nothing here reads anything. It is handed positions and levels that were already computed, and turns them into a
// page — so adding a column or a second chart later changes this file and nothing about how an account is read.
import type { Holding, AccountTotals } from "./portfolio.ts";
import type { Levels, Zone, Frame } from "./levels.ts";

export interface ReportHolding {
  holding: Holding;
  /** Absent when the stock's history could not be read; the row still appears, saying so. */
  levels?: Levels;
  /** Closes for the drawn window, oldest first. Passed in rather than taken from `levels`, which carries the rules'
   *  findings and not the bars they were found in. */
  series?: { time: string; value: number }[];
  unavailable?: string;
}
export interface ReportAccount {
  label: string; totals: AccountTotals; holdings: ReportHolding[];
  /** Holdings dropped because the provider's row could not be read, and whether paging stopped early. */
  skipped: number; truncated: boolean;
}
export interface ReportInput { accounts: ReportAccount[]; generatedAt: string; timeframe: string }

const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const money = (v: number | null | undefined, dp = 2) =>
  v === null || v === undefined ? "—" : `${v < 0 ? "−" : ""}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
const percent = (v: number | null | undefined) => v === null || v === undefined ? "—" : `${v < 0 ? "−" : "+"}${Math.abs(v).toFixed(1)}%`;
const day = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** The frame a report row is drawn from: the one the levels engine chose, which is the longest daily window with
 *  enough history. */
const shown = (levels: Levels): Frame | undefined =>
  levels.frames.find(f => f.timeframe === levels.defaultTimeframe && !f.unavailable) ?? levels.frames.find(f => !f.unavailable);

/** The nearest zone below the price, and the nearest above. */
function nearest(frame: Frame | undefined, price: number) {
  const below = frame?.support?.[0], above = frame?.resistance?.[0];
  const gap = (zone: Zone | undefined, edge: "hi" | "lo") => zone ? (zone[edge] - price) / price * 100 : null;
  return { support: below, resistance: above, toSupport: gap(below, "hi"), toResistance: gap(above, "lo") };
}
/** How close the price is to a level, in the stock's own daily range. Sorting by this puts what is near the top,
 *  which is the whole reason the rows are ordered rather than alphabetical. */
function atrsAway(frame: Frame | undefined, price: number): number {
  const { support, resistance } = nearest(frame, price);
  const atr = frame?.atr;
  if (!atr || atr <= 0) return Number.POSITIVE_INFINITY;
  const distances = [support ? price - support.hi : null, resistance ? resistance.lo - price : null]
    .filter((d): d is number => d !== null && d >= 0);
  return distances.length ? Math.min(...distances) / atr : Number.POSITIVE_INFINITY;
}

/** A small price chart with the zones drawn behind it. No axes: the numbers are in the row beside it, and a printed
 *  page has no room to waste. */
function sparkline(series: { time: string; value: number }[], frame: Frame | undefined, width = 420, height = 64): string {
  if (series.length < 2 || !frame) return `<svg class="spark" viewBox="0 0 ${width} ${height}" role="img" aria-label="No chart available"></svg>`;
  const values = series.map(p => p.value);
  const zones = [...(frame.support ?? []), ...(frame.resistance ?? [])];
  const lo = Math.min(...values, ...zones.map(z => z.lo));
  const hi = Math.max(...values, ...zones.map(z => z.hi));
  const span = hi - lo || 1;
  const x = (i: number) => (i / (series.length - 1)) * width;
  const y = (v: number) => height - ((v - lo) / span) * height;
  const band = (z: Zone, kind: string) =>
    `<rect class="${kind}" x="0" y="${y(z.hi).toFixed(1)}" width="${width}" height="${Math.max(1, y(z.lo) - y(z.hi)).toFixed(1)}"/>`;
  const path = series.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join(" ");
  const last = y(values.at(-1)!);
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Price with support and resistance">
  ${(frame.support ?? []).slice(0, 3).map(z => band(z, "s")).join("")}
  ${(frame.resistance ?? []).slice(0, 3).map(z => band(z, "r")).join("")}
  <path class="line" d="${path}"/>
  <circle class="now" cx="${width - 1}" cy="${last.toFixed(1)}" r="2.5"/>
</svg>`;
}

function row(entry: ReportHolding): string {
  const { holding, levels, series = [], unavailable } = entry;
  const symbol = escape(holding.symbol);
  if (!levels || unavailable) {
    return `<tr class="holding"><th scope="row">${symbol}</th>
      <td class="num">${holding.shares.toLocaleString("en-US")}</td>
      <td class="num">${money(holding.averageCost)}</td>
      <td class="num" colspan="5">${escape(unavailable ?? "no price history")}</td></tr>`;
  }
  const frame = shown(levels), price = levels.price;
  const value = holding.shares * price;
  const cost = holding.averageCost === null ? null : holding.averageCost * holding.shares;
  const gain = cost === null ? null : value - cost;
  const gainPct = cost === null || cost === 0 ? null : (gain! / cost) * 100;
  const { support, resistance, toSupport, toResistance } = nearest(frame, price);
  const near = atrsAway(frame, price) <= 1;
  const zone = (z: Zone | undefined, distance: number | null) => z
    ? `<span class="zone">${money(z.lo)}–${z.hi.toFixed(2)}</span><span class="dist">${percent(distance)} · ${z.tests} tests</span>`
    : "—";
  return `<tr class="holding${near ? " near" : ""}">
    <th scope="row">${symbol}${near ? '<span class="flag" title="Within a day\'s range of a level">near</span>' : ""}</th>
    <td class="num">${holding.shares.toLocaleString("en-US")}</td>
    <td class="num">${money(holding.averageCost)}</td>
    <td class="num">${money(price)}</td>
    <td class="num">${money(value, 0)}</td>
    <td class="num ${gain !== null && gain < 0 ? "down" : "up"}">${money(gain, 0)}<span class="dist">${percent(gainPct)}</span></td>
    <td class="level">${zone(support, toSupport)}</td>
    <td class="level">${zone(resistance, toResistance)}</td>
  </tr>
  <tr class="chart"><td colspan="8">${sparkline(series, frame)}</td></tr>`;
}

function account(a: ReportAccount): string {
  const rows = [...a.holdings].sort((x, y) => {
    const near = atrsAway(x.levels ? shown(x.levels) : undefined, x.levels?.price ?? 0) -
      atrsAway(y.levels ? shown(y.levels) : undefined, y.levels?.price ?? 0);
    return Number.isFinite(near) && near !== 0 ? near : x.holding.symbol.localeCompare(y.holding.symbol);
  });
  const notes: string[] = [];
  if (a.skipped) notes.push(`${a.skipped} holding${a.skipped === 1 ? "" : "s"} could not be read and ${a.skipped === 1 ? "is" : "are"} not shown.`);
  if (a.truncated) notes.push("This account has more holdings than one report can page through; the rest are not shown.");
  return `<section class="account">
  <header>
    <h2>${escape(a.label)}</h2>
    <dl class="totals">
      <div><dt>Value</dt><dd>${money(a.totals.value, 0)}</dd></div>
      <div><dt>Cash</dt><dd>${money(a.totals.cash, 0)}</dd></div>
      <div><dt>Today</dt><dd class="${(a.totals.dayChange ?? 0) < 0 ? "down" : "up"}">${money(a.totals.dayChange, 0)}</dd></div>
      <div><dt>Total return</dt><dd class="${(a.totals.totalReturn ?? 0) < 0 ? "down" : "up"}">${money(a.totals.totalReturn, 0)}</dd></div>
    </dl>
  </header>
  ${notes.length ? `<p class="note">${notes.map(escape).join(" ")}</p>` : ""}
  <table>
    <thead><tr><th scope="col">Stock</th><th scope="col">Shares</th><th scope="col">Cost</th><th scope="col">Price</th>
      <th scope="col">Value</th><th scope="col">Gain</th><th scope="col">Support below</th><th scope="col">Resistance above</th></tr></thead>
    <tbody>${rows.map(row).join("\n")}</tbody>
  </table>
</section>`;
}

/** The whole report. Self-contained: no script, no network, no fonts to fetch. */
export function portfolioReport(input: ReportInput): string {
  const accounts = input.accounts.map(account).join("\n");
  const holdings = input.accounts.reduce((n, a) => n + a.holdings.length, 0);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Portfolio levels — ${escape(day(input.generatedAt.slice(0, 10)))}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark;
    --ink: #10171c; --muted: #5a6b70; --rule: #d6dedc; --ground: #fbfcfc; --panel: #fff;
    --up: #10715a; --down: #b03a2c; --support: #0b7c75; --resistance: #a2650f;
    --support-fill: rgba(11,124,117,.13); --resistance-fill: rgba(162,101,15,.13); }
  @media (prefers-color-scheme: dark) { :root {
    --ink: #dce5e3; --muted: #8a9c9e; --rule: #24333a; --ground: #0d1316; --panel: #11191d;
    --up: #1fd286; --down: #e86a57; --support: #33c9be; --resistance: #e4a548;
    --support-fill: rgba(51,201,190,.16); --resistance-fill: rgba(228,165,72,.16); } }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px 28px 56px; background: var(--ground); color: var(--ink);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  h1 { font-size: 22px; margin: 0 0 2px; letter-spacing: -.01em; }
  .asof { color: var(--muted); margin: 0 0 28px; font-size: 13px; }
  .account { background: var(--panel); border: 1px solid var(--rule); border-radius: 10px; padding: 18px 20px 8px; margin-bottom: 22px; }
  .account > header { display: flex; flex-wrap: wrap; gap: 8px 28px; align-items: baseline; justify-content: space-between;
    border-bottom: 1px solid var(--rule); padding-bottom: 12px; margin-bottom: 4px; }
  h2 { font-size: 16px; margin: 0; }
  .totals { display: flex; gap: 22px; margin: 0; }
  .totals div { display: flex; flex-direction: column; }
  .totals dt { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
  .totals dd { margin: 0; font-variant-numeric: tabular-nums; font-weight: 600; }
  .note { color: var(--muted); font-size: 12px; margin: 10px 0 0; }
  table { width: 100%; border-collapse: collapse; }
  thead th { text-align: right; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted);
    font-weight: 600; padding: 12px 8px 6px; border-bottom: 1px solid var(--rule); white-space: nowrap; }
  thead th:first-child, tbody th { text-align: left; }
  tbody th { font-size: 15px; font-weight: 650; padding: 10px 8px 2px; }
  td { padding: 10px 8px 2px; vertical-align: baseline; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .level { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; font-size: 13px; }
  .zone { display: block; }
  .dist { display: block; color: var(--muted); font-size: 11px; }
  .up { color: var(--up); } .down { color: var(--down); }
  .flag { margin-left: 7px; font-size: 10px; text-transform: uppercase; letter-spacing: .07em; color: var(--resistance);
    border: 1px solid currentColor; border-radius: 999px; padding: 1px 6px; vertical-align: 2px; }
  tr.holding > * { border-top: 1px solid var(--rule); }
  tr.chart td { padding: 2px 8px 12px; }
  .spark { width: 100%; height: 56px; display: block; }
  .spark .line { fill: none; stroke: var(--ink); stroke-width: 1.2; vector-effect: non-scaling-stroke; }
  .spark .now { fill: var(--ink); }
  .spark .s { fill: var(--support-fill); } .spark .r { fill: var(--resistance-fill); }
  footer { color: var(--muted); font-size: 12px; margin-top: 26px; }
  @media print {
    :root { --ink: #000; --muted: #444; --rule: #bbb; --ground: #fff; --panel: #fff;
      --up: #000; --down: #000; --support-fill: #eee; --resistance-fill: #e4e4e4; }
    body { padding: 0; font-size: 11pt; }
    .account { break-inside: auto; page-break-inside: auto; border: 0; padding: 0; margin-bottom: 18pt; }
    tr.holding, tr.chart { break-inside: avoid; page-break-inside: avoid; }
    .account + .account { break-before: page; page-break-before: always; }
    .spark { height: 42px; }
    footer { position: fixed; bottom: 0; }
  }
</style></head>
<body>
<h1>Portfolio levels</h1>
<p class="asof">${escape(day(input.generatedAt.slice(0, 10)))} · ${holdings} holding${holdings === 1 ? "" : "s"} · ${escape(input.timeframe)} window · prices from the last session that closed</p>
${accounts}
<footer>Support and resistance are computed from daily price bars by a fixed set of rules. They describe what those
rules found, not what to buy or sell. Astra places no orders.</footer>
</body></html>`;
}
