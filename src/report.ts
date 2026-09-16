// The portfolio report: one self-contained HTML page, meant to be read on screen and printed.
//
// Charts are inline SVG rather than a charting library. Printing is the binding constraint: a canvas chart needs
// ~600 KB of inlined JavaScript per page and prints badly, while an SVG per holding is a few kilobytes, needs no
// script at all, and comes out of "save as PDF" exactly as it looks.
//
// Nothing here reads anything. It is handed positions and levels that were already computed, and turns them into a
// page — so adding a column or a second chart later changes this file and nothing about how an account is read.
import { createHash } from "node:crypto";
import type { Holding, AccountTotals } from "./portfolio.ts";
import type { Levels, Zone, Frame, Gap, TrendLine } from "./levels.ts";

export interface Point { time: string; value: number }
export interface ReportHolding {
  holding: Holding;
  /** Absent when the stock's history could not be read; the row still appears, saying so. */
  levels?: Levels;
  /** Closes, oldest first, for every frame to be drawn from: the daily series, and the weekly one when a weekly
   *  frame was computed. Passed in rather than taken from `levels`, which carries the rules' findings and not the
   *  bars they were found in. Each chart slices what it needs by its own frame's start. */
  series?: { daily: Point[]; weekly?: Point[] };
  unavailable?: string;
}
export interface ReportAccount {
  label: string; totals: AccountTotals; holdings: ReportHolding[];
  /** Holdings dropped because the provider's row could not be read, and whether paging stopped early. */
  skipped: number; truncated: boolean;
}
export interface ReportInput { accounts: ReportAccount[]; generatedAt: string }

/** What window the headline may claim. Each row is drawn from its own symbol's chosen frame, and a stock listed two
 *  years ago has a shorter one than a stock listed in 1980 — so a fixed label on the page would be wrong for exactly
 *  the holdings whose history is short. Named only when every row agrees. */
function window(input: ReportInput): string {
  const labels = new Set<string>();
  for (const a of input.accounts) for (const r of a.holdings) if (r.levels) labels.add(shown(r.levels)?.label ?? "");
  labels.delete("");
  return labels.size === 1 ? `${[...labels][0]} window` : "each stock's longest available window";
}

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

/** A chart with room to read it: price, the zones as labelled bands, unfilled gaps, the trend line, and a price
 *  scale. Drawn at a fixed viewBox and scaled by CSS, so it is equally legible on screen and on paper. */
const W = 960, H = 380, PAD_B = 22, PAD_T = 26;
function chart(points: Point[], frame: Frame, price: number, label: string, cost: number | null): string {
  if (points.length < 2) return `<p class="note">Not enough history to draw ${escape(label)}.</p>`;
  const values = points.map(p => p.value);
  // Only the nearest zones are drawn. Twenty bands is not a chart, it is a wall — the rest are in get_levels.
  const support = (frame.support ?? []).slice(0, 3), resistance = (frame.resistance ?? []).slice(0, 3);
  const zones = [...support, ...resistance];
  const gaps = (frame.gaps ?? []).slice(0, 3);
  // Room for the longest label there will actually be, rather than a guess that the text then overflows.
  const width = (text: string) => text.length * 6.2 + 12;
  const PAD_R = Math.round(Math.min(260, Math.max(96, ...zones.map(z => width(`${money(z.lo)}–${z.hi.toFixed(2)} ${z.tests} held`)),
    width(`${money(price)} last close`), ...(cost ? [width(`${money(cost)} your cost (off scale)`)] : []))));
  const plot = W - PAD_R, plotH = H - PAD_B - PAD_T;
  const marks = [price, ...(cost ? [cost] : [])];
  const lo = Math.min(...values, ...zones.map(z => z.lo), ...gaps.map(g => g.lo), ...marks);
  const hi = Math.max(...values, ...zones.map(z => z.hi), ...gaps.map(g => g.hi), ...marks);
  const pad = (hi - lo) * 0.06 || 1;
  const top = hi + pad, bottom = Math.max(0, lo - pad), span = top - bottom || 1;
  const x = (i: number) => (i / (points.length - 1)) * plot;
  const y = (v: number) => PAD_T + (1 - (v - bottom) / span) * plotH;
  const at = (v: number) => y(Math.min(top, Math.max(bottom, v)));

  // Labels are placed top to bottom and pushed apart when they would overlap, so two zones a few cents apart are
  // still both readable rather than printed on top of one another.
  const placed: number[] = [];
  const freeY = (want: number) => {
    let y = Math.min(H - 4, Math.max(PAD_T, want));
    // Re-check after each nudge: moving clear of one label can move onto the next.
    for (let guard = 0; guard < 40 && placed.some(taken => Math.abs(y - taken) < 13); guard++) {
      y = Math.max(...placed.filter(taken => Math.abs(y - taken) < 13)) + 13;
    }
    placed.push(y);
    return y;
  };
  const band = (z: Zone, kind: "s" | "r") => {
    const y1 = at(z.hi), y2 = at(z.lo), height = Math.max(1.5, y2 - y1);
    const text = freeY(y1 + height / 2 + 3.5);
    return `<g class="${kind}"><rect x="0" y="${y1.toFixed(1)}" width="${plot}" height="${height.toFixed(1)}"/>` +
      `<text x="${plot + 6}" y="${text.toFixed(1)}">${money(z.lo)}–${z.hi.toFixed(2)}` +
      `<tspan class="tests"> ${z.tests} held</tspan></text></g>`;
  };
  const gap = (g: Gap) => {
    const start = Math.max(0, points.findIndex(p => p.time >= g.from));
    const y1 = at(g.hi), y2 = at(g.lo);
    return `<rect class="gap" x="${x(start).toFixed(1)}" y="${y1.toFixed(1)}" width="${(plot - x(start)).toFixed(1)}" height="${Math.max(1.5, y2 - y1).toFixed(1)}"/>`;
  };
  const trend = (line: TrendLine | null | undefined) => {
    if (!line) return "";
    const from = points.findIndex(p => p.time >= line.from);
    if (from < 0) return "";
    return `<line class="trend${line.confirmed ? "" : " tentative"}" x1="${x(from).toFixed(1)}" y1="${at(line.fromValue).toFixed(1)}" x2="${plot.toFixed(1)}" y2="${at(line.toValue).toFixed(1)}"/>`;
  };
  // Four price gridlines, on round numbers rather than wherever the data happens to land.
  const step = Math.pow(10, Math.floor(Math.log10(span / 4))) * ([1, 2, 5, 10].find(m => span / 4 <= m * Math.pow(10, Math.floor(Math.log10(span / 4)))) ?? 1);
  const ticks: number[] = [];
  for (let v = Math.ceil(bottom / step) * step; v <= top && ticks.length < 8; v += step) ticks.push(v);
  const dates = [0, Math.floor((points.length - 1) / 2), points.length - 1];

  // The price and the cost claim their label position first, so a zone label never covers either.
  const priceY = freeY(at(price) + 3.5);
  const costY = cost ? freeY(at(cost) + 3.5) : 0;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escape(label)}: price with support and resistance">
  <text class="title" x="0" y="13">${escape(label)}</text>
  ${ticks.map(v => `<line class="grid" x1="0" y1="${y(v).toFixed(1)}" x2="${plot}" y2="${y(v).toFixed(1)}"/>`).join("\n  ")}
  ${gaps.map(gap).join("")}
  ${support.map(z => band(z, "s")).join("")}
  ${resistance.map(z => band(z, "r")).join("")}
  ${trend(frame.trend?.support)}${trend(frame.trend?.resistance)}
  <path class="line" d="${points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join(" ")}"/>
  ${cost ? `<line class="cost" x1="0" y1="${at(cost).toFixed(1)}" x2="${plot}" y2="${at(cost).toFixed(1)}"/>
  <text class="costlabel" x="${plot + 6}" y="${costY.toFixed(1)}">${money(cost)} your cost${cost < bottom || cost > top ? " (off scale)" : ""}</text>` : ""}
  <line class="now" x1="0" y1="${at(price).toFixed(1)}" x2="${plot}" y2="${at(price).toFixed(1)}"/>
  <text class="nowlabel" x="${plot + 6}" y="${priceY.toFixed(1)}">${money(price)} last close</text>
  ${dates.map((i, n) => `<text class="date" x="${Math.min(plot - 30, Math.max(2, x(i))).toFixed(1)}" y="${H - 6}" text-anchor="${n === 0 ? "start" : n === 1 ? "middle" : "end"}">${escape(day(points[i]!.time))}</text>`).join("\n  ")}
</svg>`;
}

/** The expandable technicals for one holding: every timeframe the engine computed, as tabs. `details` and radio
 *  inputs, so there is no script — the page prints, and whatever is left open prints open. */
function technicals(symbol: string, levels: Levels, series: { daily: Point[]; weekly?: Point[] }, cost: number | null, id: string): string {
  const frames = levels.frames;
  const pane = (frame: Frame) => {
    if (frame.unavailable) return `<div class="pane"><p class="note">${escape(frame.unavailable)}</p></div>`;
    const source = frame.bar === "week" ? series.weekly ?? [] : series.daily;
    const from = Math.max(0, source.findIndex(p => p.time >= frame.start));
    const bar = frame.bar === "week" ? "week" : "day";
    return `<div class="pane">${chart(source.slice(from), frame, levels.price, `${symbol} · ${frame.label}`, cost)}
      <p class="legend">Measured on ${bar === "week" ? "weekly" : "daily"} bars: a ${bar} moves ${money(frame.atr)} on average, and that sets how wide these zones are. The nearest three zones on each side are drawn — shaded below the price is support, above it resistance — and each is labelled with how many ${bar}s traded into it without closing through. A dashed box is a gap the price has not traded back into. Changing the tab changes the window the rules looked at, so the zones change with it.</p></div>`;
  };
  const selected = Math.max(0, frames.findIndex(x => x.timeframe === levels.defaultTimeframe));
  return `<details class="technicals"><summary>Technicals — price, cost and levels<span class="chev" aria-hidden="true"></span></summary>
  <div class="tabs">
    ${frames.map((f, i) => `<input type="radio" name="tf-${id}" id="tf-${id}-${i}"${i === selected ? " checked" : ""}><label for="tf-${id}-${i}">${escape(f.label)}</label>`).join("\n    ")}
    <div class="panes">${frames.map(pane).join("\n")}</div>
  </div></details>`;
}

function row(entry: ReportHolding, id: string): string {
  const { holding, levels, series = { daily: [] }, unavailable } = entry;
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
  const away = atrsAway(frame, price);
  const near = away <= 1;
  const side = near ? (Math.abs(toSupport ?? Infinity) <= Math.abs(toResistance ?? Infinity) ? "support" : "resistance") : "";
  const zone = (z: Zone | undefined, distance: number | null) => z
    ? `<span class="zone">${money(z.lo)}–${z.hi.toFixed(2)}</span><span class="dist">${percent(distance)} · held ${z.tests}</span>`
    : "—";
  return `<tr class="holding${near ? " near" : ""}">
    <th scope="row">${symbol}${near ? `<span class="flag" title="Within one average daily range of this level">near ${side}</span>` : ""}</th>
    <td class="num">${holding.shares.toLocaleString("en-US")}</td>
    <td class="num">${money(holding.averageCost)}</td>
    <td class="num">${money(price)}</td>
    <td class="num">${money(value, 0)}</td>
    <td class="num ${gain !== null && gain < 0 ? "down" : "up"}">${money(gain, 0)}<span class="dist">${percent(gainPct)}</span></td>
    <td class="level">${zone(support, toSupport)}</td>
    <td class="level">${zone(resistance, toResistance)}</td>
  </tr>
  <tr class="expand"><td colspan="8">${technicals(holding.symbol, levels, series, holding.averageCost, id)}</td></tr>`;
}

function account(a: ReportAccount, scope: number): string {
  // Nearest to a level first, alphabetical only to break a tie. A row with no levels has no distance, so it sorts to
  // the end by a sentinel rather than by Infinity: subtracting two Infinities gives NaN, and subtracting one from a
  // finite number gives -Infinity, so a single unpriced holding used to make the whole comparator fall through to
  // alphabetical — the ordering this report exists to give would quietly disappear on exactly the accounts that have
  // an unreadable or uncharted holding.
  const distance = (r: ReportHolding) => {
    const away = r.levels ? atrsAway(shown(r.levels), r.levels.price) : Infinity;
    return Number.isFinite(away) ? away : Number.MAX_SAFE_INTEGER;
  };
  const rows = [...a.holdings].sort((x, y) =>
    distance(x) - distance(y) || x.holding.symbol.localeCompare(y.holding.symbol));
  // The rows are equities. Robinhood's account value counts everything in the account, options and crypto included,
  // so the two are not the same number and the report says so rather than leaving a reader to find the gap.
  const priced = rows.filter(r => r.levels).reduce((n, r) => n + r.holding.shares * r.levels!.price, 0);
  const unpriced = rows.filter(r => !r.levels).length;
  const value = a.totals.value;
  const elsewhere = value !== null && !unpriced ? value - priced - (a.totals.cash ?? 0) : null;
  const notes: string[] = [];
  if (a.skipped) notes.push(`${a.skipped} holding${a.skipped === 1 ? "" : "s"} could not be read and ${a.skipped === 1 ? "is" : "are"} not shown.`);
  if (a.truncated) notes.push("This account has more holdings than one report can page through; the rest are not shown.");
  if (elsewhere !== null && !a.truncated && Math.abs(elsewhere) > Math.max(1, (value ?? 0) * 0.005))
    notes.push(`${money(elsewhere, 0)} of this account's value is not in the table below: it covers equities only, while the account value counts everything, including options and crypto.`);
  if (unpriced) notes.push(`${unpriced} holding${unpriced === 1 ? " has" : "s have"} no price here, so the equities total excludes ${unpriced === 1 ? "it" : "them"}.`);
  return `<section class="account">
  <header>
    <h2>${escape(a.label)}</h2>
    <dl class="totals">
      <div><dt>Account value</dt><dd>${money(value, 0)}</dd></div>
      <div><dt>Equities here</dt><dd>${money(priced, 0)}</dd></div>
      <div><dt>Cash</dt><dd>${money(a.totals.cash, 0)}</dd></div>
      <div><dt>Today</dt><dd class="${(a.totals.dayChange ?? 0) < 0 ? "down" : "up"}">${money(a.totals.dayChange, 0)}</dd></div>
      <div><dt>Total return</dt><dd class="${(a.totals.totalReturn ?? 0) < 0 ? "down" : "up"}">${money(a.totals.totalReturn, 0)}</dd></div>
    </dl>
  </header>
  ${notes.length ? `<p class="note">${notes.map(escape).join(" ")}</p>` : ""}
  <table>
    <thead><tr><th scope="col">Stock</th><th scope="col">Shares</th><th scope="col">Avg cost/share</th><th scope="col">Last close</th>
      <th scope="col">Value</th><th scope="col">Unrealized P&amp;L</th><th scope="col">Support below</th><th scope="col">Resistance above</th></tr></thead>
    <tbody>${rows.map((r, i) => row(r, `${scope}-${i}`)).join("\n")}</tbody>
  </table>
</section>`;
}

/** What the chat should say out loud, so the model can speak in a paragraph and leave the detail in the report.
 *  Small on purpose: totals, the accounts, what is sitting on a level, and the extremes. */
export interface PortfolioOverview {
  asOf: string; accounts: { label: string; value: number | null; dayChange: number | null; holdings: number }[];
  totalValue: number | null; totalDayChange: number | null;
  near: { symbol: string; side: "support" | "resistance"; zone: string; distancePct: number; tests: number }[];
  best: { symbol: string; gainPct: number }[]; worst: { symbol: string; gainPct: number }[];
  unreadable: string[];
  /** Accounts whose totals could not be read. While this is non-empty the portfolio totals are null, not partial. */
  unreadableAccounts: string[];
}
export function overview(input: ReportInput): PortfolioOverview {
  const near: PortfolioOverview["near"] = [], gains: { symbol: string; gainPct: number }[] = [], unreadable: string[] = [];
  // A total is the sum of every account or it is nothing. Treating one unreadable account as zero produces a number
  // that looks like the whole portfolio and is short by an account — and the chat is told to read this figure out.
  // A missing total is answerable ("I couldn't read one account"); a quietly understated one is not.
  const sum = (pick: (a: ReportAccount) => number | null) =>
    input.accounts.every(a => pick(a) !== null) ? input.accounts.reduce((n, a) => n + pick(a)!, 0) : null;
  for (const account of input.accounts) for (const entry of account.holdings) {
    const { holding, levels } = entry;
    if (!levels) { unreadable.push(holding.symbol); continue; }
    const frame = shown(levels);
    if (holding.averageCost) gains.push({ symbol: holding.symbol, gainPct: (levels.price - holding.averageCost) / holding.averageCost * 100 });
    if (atrsAway(frame, levels.price) > 1) continue;
    const { support, resistance, toSupport, toResistance } = nearest(frame, levels.price);
    const closerToSupport = support && (!resistance || Math.abs(toSupport ?? Infinity) <= Math.abs(toResistance ?? Infinity));
    const zone = closerToSupport ? support : resistance;
    if (!zone) continue;
    near.push({ symbol: holding.symbol, side: closerToSupport ? "support" : "resistance",
      zone: `${money(zone.lo)}–${zone.hi.toFixed(2)}`, distancePct: Number(((closerToSupport ? toSupport : toResistance) ?? 0).toFixed(1)), tests: zone.tests });
  }
  const ranked = [...gains].sort((a, b) => b.gainPct - a.gainPct).map(g => ({ ...g, gainPct: Number(g.gainPct.toFixed(1)) }));
  return { asOf: input.generatedAt.slice(0, 10),
    accounts: input.accounts.map(a => ({ label: a.label, value: a.totals.value, dayChange: a.totals.dayChange, holdings: a.holdings.length })),
    totalValue: sum(a => a.totals.value), totalDayChange: sum(a => a.totals.dayChange),
    near, best: ranked.slice(0, 3), worst: ranked.slice(-3).reverse().filter(g => !ranked.slice(0, 3).includes(g)), unreadable,
    unreadableAccounts: input.accounts.filter(a => a.totals.value === null).map(a => a.label) };
}

// The page's only script: the print button, and pointing "save" at the page itself. Its hash is named in the policy
// below, so this exact text may run and nothing else — including anything that reached the markup.
const SCRIPT = `document.getElementById("print").addEventListener("click",function(){window.print()});` +
  `document.getElementById("save").setAttribute("href",window.location.href);`;
/** The report's policy — the page's own, and the one the server sends with it.
 *
 *  Both must say the same thing. A browser given two policies enforces both, so a served page is held to their
 *  intersection: a header that says `default-src 'none'` and names no `script-src` forbids the very script the page
 *  pins by hash, and the print button silently stops working. One exported policy is why that cannot drift. */
export const REPORT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; " +
  `script-src 'sha256-${createHash("sha256").update(SCRIPT).digest("base64")}'; base-uri 'none'; form-action 'none'`;

/** The whole report. Self-contained: no network, no fonts to fetch, and one small script for the print button whose
 *  hash is named in the page's own policy, so nothing else can run even if something got into the markup. */
export function portfolioReport(input: ReportInput): string {
  const accounts = input.accounts.map((a, i) => account(a, i)).join("\n");
  const holdings = input.accounts.reduce((n, a) => n + a.holdings.length, 0);
  const script = SCRIPT;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Portfolio levels — ${escape(day(input.generatedAt.slice(0, 10)))}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="content-security-policy" content="${REPORT_CSP}">
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
  /* Technicals: a details element and radio tabs, so the page needs no script and prints as it is left. */
  tr.expand td { padding: 0 8px 10px; }
  .technicals summary { cursor: pointer; display: inline-flex; align-items: center; gap: 6px; font-size: 12px;
    color: var(--muted); padding: 3px 0; list-style: none; user-select: none; }
  .technicals summary::-webkit-details-marker { display: none; }
  .technicals summary:hover { color: var(--ink); }
  .chev { width: 0; height: 0; border-left: 4px solid currentColor; border-top: 3.5px solid transparent;
    border-bottom: 3.5px solid transparent; transition: transform .12s; }
  .technicals[open] .chev { transform: rotate(90deg); }
  .tabs { margin: 8px 0 4px; }
  .tabs > input { position: absolute; opacity: 0; pointer-events: none; }
  .tabs > label { display: inline-block; font-size: 11px; letter-spacing: .04em; text-transform: uppercase;
    color: var(--muted); border: 1px solid var(--rule); border-radius: 999px; padding: 3px 11px; margin: 0 6px 8px 0; cursor: pointer; }
  .tabs > input:checked + label { color: var(--ground); background: var(--ink); border-color: var(--ink); }
  .tabs > input:focus-visible + label { outline: 2px solid var(--resistance); outline-offset: 2px; }
  .panes > .pane { display: none; }
  /* Positional, so one rule set serves every holding: the nth tab shows the nth pane. */
  .tabs > input:nth-of-type(1):checked ~ .panes > .pane:nth-child(1),
  .tabs > input:nth-of-type(2):checked ~ .panes > .pane:nth-child(2),
  .tabs > input:nth-of-type(3):checked ~ .panes > .pane:nth-child(3),
  .tabs > input:nth-of-type(4):checked ~ .panes > .pane:nth-child(4) { display: block; }
  .chart { width: 100%; height: auto; display: block; }
  .chart .grid { stroke: var(--rule); stroke-width: 1; }
  .chart .line { fill: none; stroke: var(--ink); stroke-width: 1.6; vector-effect: non-scaling-stroke; }
  .chart .now { stroke: var(--ink); stroke-width: 1; stroke-dasharray: 4 3; opacity: .75; }
  .chart .s rect { fill: var(--support-fill); } .chart .r rect { fill: var(--resistance-fill); }
  .chart .s text { fill: var(--support); } .chart .r text { fill: var(--resistance); }
  .chart text { font: 11px ui-monospace, "SF Mono", Menlo, monospace; }
  .chart .tests { opacity: .65; }
  .chart .tick, .chart .date { fill: var(--muted); }
  .chart .nowlabel { fill: var(--ink); font-weight: 600; }
  .chart .gap { fill: none; stroke: var(--muted); stroke-dasharray: 3 3; stroke-width: 1; }
  .chart .trend { stroke: var(--ink); stroke-width: 1.4; opacity: .55; }
  .chart .trend.tentative { stroke-dasharray: 5 4; }
  .chart .title { fill: var(--ink); font-weight: 650; font-size: 12px; }
  .chart .cost { stroke: var(--muted); stroke-width: 1.2; stroke-dasharray: 2 3; }
  .chart .costlabel { fill: var(--muted); }
  .legend { color: var(--muted); font-size: 11px; margin: 4px 0 8px; }
  footer { color: var(--muted); font-size: 12px; margin-top: 26px; }
  .top { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; flex-wrap: wrap; }
  .actions { display: flex; gap: 10px; align-items: center; }
  .actions button, .actions a { font: inherit; font-size: 12px; color: var(--ink); background: var(--panel);
    border: 1px solid var(--rule); border-radius: 7px; padding: 6px 12px; cursor: pointer; text-decoration: none; }
  .actions button:hover, .actions a:hover { border-color: var(--ink); }
  @media print {
    :root { --ink: #000; --muted: #444; --rule: #bbb; --ground: #fff; --panel: #fff;
      --up: #000; --down: #000; --support-fill: #eee; --resistance-fill: #e4e4e4; }
    body { padding: 0; font-size: 11pt; }
    .actions { display: none; }
    .account { break-inside: auto; page-break-inside: auto; border: 0; padding: 0; margin-bottom: 18pt; }
    tr.holding { break-inside: avoid; page-break-inside: avoid; }
    tr.holding, tr.expand { break-after: auto; page-break-after: auto; }
    .account + .account { break-before: page; page-break-before: always; }
    /* A chart prints only where one was opened, and only the timeframe that was chosen — opening a holding must not
       quietly put four charts on paper. The tab labels go, so the chart's own title carries the timeframe. */
    .technicals summary, .tabs > label { display: none; }
    .technicals:not([open]) { display: none; }
    .panes > .pane { break-inside: avoid; page-break-inside: avoid; }
    .chart { max-height: 3.2in; }
    .legend { font-size: 9pt; }
    thead th { font-size: 9pt; }
    .dist, .note { font-size: 9pt; }
    /* Space is reserved for the footer rather than letting it sit on top of the last row. */
    @page { margin: 12mm 12mm 18mm; }
    footer { position: fixed; bottom: 0; font-size: 9pt; }
  }
</style></head>
<body>
<header class="top">
  <div>
    <h1>Portfolio levels</h1>
    <p class="asof">${escape(day(input.generatedAt.slice(0, 10)))} · ${holdings} holding${holdings === 1 ? "" : "s"} · ${escape(window(input))} · prices from the last session that closed</p>
  </div>
  <div class="actions">
    <button id="print" type="button">Print or save as PDF</button>
    <a id="save" download="portfolio-${escape(input.generatedAt.slice(0, 10))}.html" href="">Save this page</a>
  </div>
</header>
${accounts}
<footer>Prices are the last close of the session named above; distances are measured from that close to the nearest edge of
a zone. Support and resistance are computed by fixed rules from daily bars, or from weekly bars on the five-year
chart, and "held 24" counts how many bars traded into that zone without closing through it — a record of what
happened, not a probability that it happens again. Nothing here is a recommendation to buy or sell, and Astra places
no orders.</footer>
<script>${script}</script>
</body></html>`;
}
