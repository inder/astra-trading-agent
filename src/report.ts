// The portfolio report: one self-contained HTML page, meant to be read on screen and printed.
//
// Charts are inline SVG rather than a charting library. Printing is the binding constraint: a canvas chart needs
// ~600 KB of inlined JavaScript per page and prints badly, while an SVG per holding is a few kilobytes, needs no
// script at all, and comes out of "save as PDF" exactly as it looks.
//
// Nothing here reads anything. It is handed positions and levels that were already computed, and turns them into a
// page — so adding a column or a second chart later changes this file and nothing about how an account is read.
import { createHash } from "node:crypto";
import type { Holding, AccountTotals, OptionValuation } from "./portfolio.ts";
import type { Levels, Zone, Frame, Gap, TrendLine } from "./levels.ts";

export interface Point { time: string; value: number }
/** One held contract, as the page shows it. The terms — strike and right — are absent when the instrument lookup
 *  could not supply them; the row still renders from what the position knows, because a contract that carries value
 *  must never be dropped for want of a label. */
export interface ReportContract {
  expiry: string;
  contracts: number;
  direction: "long" | "short" | null;
  right: "call" | "put" | null;
  strike: number | null;
  multiplier: number | null;
  /** Premium per quoted unit, as opened. */
  averageCostPerShare: number | null;
  /** The current price, and when it was taken. A contract's price and its underlying's last trade are two different
   *  clocks, and the page says both rather than implying one time for the row. */
  mark: number | null;
  markAt: string | null;
  /** Which number `mark` is: the provider's live mark, or the last settled close. They are different facts and a
   *  contract priced from Friday's close beside one priced this morning must not read as the same kind of number. */
  markSource?: "mark" | "close" | null;
  value: OptionValuation | null;
  /** Why this row carries no terms, or no value, when it does not. */
  note?: string;
  /** Why this contract's strike is not drawn on the chart, when it is not. */
  strikeNotDrawn?: string;
}

/** One **underlying** and everything held in it: the share position if there is one, the contracts if there are any,
 *  and the levels they are all read against. A group may have no shares at all — one of the founder's accounts holds
 *  only options — which is why `holding` is optional and `symbol` is not. */
export interface ReportHolding {
  symbol: string;
  holding?: Holding;
  contracts?: ReportContract[];
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
  /** What is known about this account's option contracts. They are not listed yet; this is what stands behind the
   *  options figure.
   *
   *  It is not a bare count, because a bare count cannot tell four things apart: an account that holds no options, a
   *  read that failed, a grant without the tool, and a read that returned rows every one of which was unreadable.
   *  The last is the one that matters — the normalizer is keyed field by field to a payload shape, and a provider
   *  that renames a field does not error, it drops every row. A count would then say "no options" to someone who
   *  holds options, with nothing on the page to notice it by.
   *
   *  `count` is contracts; `positions` is the rows they arrived in. Both are needed because they answer different
   *  questions and a single number has been read as the wrong one: four contracts in one row is not one contract. */
  options?: { count: number; positions: number; skipped: number; truncated: boolean } | "unreadable";
}
export interface ReportInput { accounts: ReportAccount[]; generatedAt: string }

/** What window the headline may claim. Each row is drawn from its own symbol's chosen frame, and a stock listed two
 *  years ago has a shorter one than a stock listed in 1980 — so a fixed label on the page would be wrong for exactly
 *  the holdings whose history is short. Named only when every row agrees. */
function windowLabel(input: ReportInput): string {
  const labels = new Set<string>();
  for (const a of input.accounts) for (const r of a.holdings) if (r.levels) labels.add(shown(r.levels)?.label ?? "");
  labels.delete("");
  // Three cases, not two. With nothing measured there is no window to name, and a report of zero readable holdings
  // claiming "each stock's longest available window" describes stocks it does not have.
  if (labels.size === 0) return "";
  return labels.size === 1 ? `${[...labels][0]} window` : "each stock's own window";
}

const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const money = (v: number | null | undefined, dp = 2) =>
  v === null || v === undefined ? "—" : `${v < 0 ? "−" : ""}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
const percent = (v: number | null | undefined) => v === null || v === undefined ? "—" : `${v < 0 ? "−" : "+"}${Math.abs(v).toFixed(1)}%`;
const day = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
/** The time of day a trade happened, in the market's own timezone — the only one a closing price means anything in. */
const easternTime = (iso: string) => new Date(iso).toLocaleString("en-US",
  { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
/** What the price beside a holding actually is. A closing price and an after-hours trade are different facts, and a
 *  column that shows one under the other's name is how a report misleads without stating a single wrong number. */
function priceNote(levels: Levels, short = false): string {
  if (levels.priceSource === "close") return `close ${day(levels.asOf)}`;
  const when = !short && levels.priceAt ? ` ${easternTime(levels.priceAt)} ET` : "";
  if (levels.priceSource === "after-hours") return `after hours${when}`;
  if (levels.priceSource === "pre-market") return `pre-market${when}`;
  return `last trade${when}`;
}

/** What can honestly be said about an account's contracts. Each state gets its own words, because the four of them
 *  mean different things and a reader acts differently on each: nothing held, nothing readable, a complete count, a
 *  count that stopped early, and a count with rows it could not parse. */
function optionNote(options: NonNullable<ReportAccount["options"]>, value: number): string {
  if (options === "unreadable") return "the contracts behind it could not be read";
  const { count, positions, skipped, truncated } = options;
  if (!count && skipped) return `none of its ${skipped} contract row${skipped === 1 ? "" : "s"} could be read`;
  // No rows at all, nothing dropped, and yet the account reports an options figure: the provider is disagreeing with
  // itself, and "0 open contracts" would take one side of that and state it as fact. This is also the shape an
  // unanticipated payload wrapper produces — rows arriving somewhere the reader does not look — so it is the one
  // remaining way a drift could be reported as a number rather than as a doubt.
  //
  // Tested on the figure being non-zero rather than positive. A short book's options value is NEGATIVE, so `> 0`
  // sent exactly the account most likely to be misread — one carrying written contracts — down the path that says
  // nothing at all. And zero is not proof of an empty book either: a long and a short that offset report zero while
  // two contracts stand open. So the sentence below hedges on the figure, and the count governs.
  if (!count && Math.abs(value) >= 0.5) return "no contract rows came back for it";
  const contracts = `${count}${truncated ? "+" : ""} open contract${count === 1 && !truncated ? "" : "s"}`;
  // Rows only where they differ from contracts. "4 open contracts across 1 position" earns its words; "across 4
  // positions" beside 4 contracts is noise.
  const across = positions && positions !== count ? `${contracts} across ${positions} position${positions === 1 ? "" : "s"}` : contracts;
  if (truncated) return `${across}, more than one report can page through`;
  if (skipped) return `${across}, and ${skipped} row${skipped === 1 ? "" : "s"} that could not be read`;
  return across;
}

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
interface StrikeMark { value: number; label: string }
function chart(points: Point[], frame: Frame, price: number, label: string, cost: number | null, priceLabel: string,
               strikes: StrikeMark[] = []): string {
  if (points.length < 2) return `<p class="note">Not enough history to draw ${escape(label)}.</p>`;
  const values = points.map(p => p.value);
  // Only the nearest zones are drawn. Twenty bands is not a chart, it is a wall — the rest are in get_levels.
  const support = (frame.support ?? []).slice(0, 3), resistance = (frame.resistance ?? []).slice(0, 3);
  const zones = [...support, ...resistance];
  const gaps = (frame.gaps ?? []).slice(0, 3);
  // Room for the longest label there will actually be, rather than a guess that the text then overflows.
  const width = (text: string) => text.length * 6.2 + 12;
  const PAD_R = Math.round(Math.min(260, Math.max(96, ...zones.map(z => width(`${money(z.lo)}–${z.hi.toFixed(2)} ${z.tests} held`)),
    width(`${money(price)} ${priceLabel}`), ...strikes.map(s => width(`${s.label} (off scale)`)),
    ...(cost ? [width(`${money(cost)} your cost (off scale)`)] : []))));
  const plot = W - PAD_R, plotH = H - PAD_B - PAD_T;
  // The price history is what the chart is FOR. A share cost or a held strike far outside it stretches the axis
  // until the series itself is a flat line at one edge — a $310 cost against a $130 market price, or a strike bought
  // far out of the money. So a mark joins the domain only when it is near the data that is being drawn, and
  // otherwise is drawn clamped to the edge and labelled as off scale. The current price always joins it: a chart
  // that does not reach today's price is not a chart of this holding.
  const dataLo = Math.min(...values, ...zones.map(z => z.lo), ...gaps.map(g => g.lo));
  const dataHi = Math.max(...values, ...zones.map(z => z.hi), ...gaps.map(g => g.hi));
  const slack = (dataHi - dataLo) * 0.25 || 1;
  const near = (v: number) => v >= dataLo - slack && v <= dataHi + slack;
  const marks = [price, ...[...(cost === null ? [] : [cost]), ...strikes.map(s => s.value)].filter(near)];
  const lo = Math.min(dataLo, ...marks);
  const hi = Math.max(dataHi, ...marks);
  const pad = (hi - lo) * 0.06 || 1;
  const top = hi + pad, bottom = Math.max(0, lo - pad), span = top - bottom || 1;
  const x = (i: number) => (i / (points.length - 1)) * plot;
  const y = (v: number) => PAD_T + (1 - (v - bottom) / span) * plotH;
  const at = (v: number) => y(Math.min(top, Math.max(bottom, v)));

  // Labels are placed top to bottom and pushed apart when they would overlap, so two zones a few cents apart are
  // still both readable rather than printed on top of one another.
  const MIN_Y = PAD_T, MAX_Y = H - 4, APART = 13;
  const placed: number[] = [];
  const collisions = (y: number) => placed.filter(taken => Math.abs(y - taken) < APART);
  const freeY = (want: number) => {
    const start = Math.min(MAX_Y, Math.max(MIN_Y, want));
    let y = start;
    // Re-check after each nudge: moving clear of one label can move onto the next.
    for (let guard = 0; guard < 40 && collisions(y).length; guard++) y = Math.max(...collisions(y)) + APART;
    // Nudging ran out of chart. The clamp above bounds where the search STARTS; every nudge since has moved down
    // without a bound, which is how labels came to be written below the viewBox — where they are not clipped or
    // warned about, simply not drawn. Search upward from where the label was wanted instead.
    if (y > MAX_Y) {
      y = start;
      for (let guard = 0; guard < 40 && collisions(y).length; guard++) y = Math.min(...collisions(y)) - APART;
    }
    // Both directions full. A label overlapping another inside the chart is hard to read; one outside it is
    // invisible, and takes its band's price with it. Prefer the overlap.
    y = Math.min(MAX_Y, Math.max(MIN_Y, y));
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
  ${strikes.map(s => {
    // Drawn against the UNDERLYING's price axis, which is the only axis here. A strike is not a breakeven and is
    // never labelled as one — a $130 call bought at $6.20 breaks even at $136.20, and nothing on this chart says
    // otherwise because nothing on it mentions breakeven at all.
    const sy = at(s.value);
    return `<g class="strike"><line x1="0" y1="${sy.toFixed(1)}" x2="${plot}" y2="${sy.toFixed(1)}"/>` +
      `<text x="${plot + 6}" y="${freeY(sy + 3.5).toFixed(1)}">${escape(s.label)}${s.value < bottom || s.value > top ? " (off scale)" : ""}</text></g>`;
  }).join("\n  ")}
  <line class="now" x1="0" y1="${at(price).toFixed(1)}" x2="${plot}" y2="${at(price).toFixed(1)}"/>
  <text class="nowlabel" x="${plot + 6}" y="${priceY.toFixed(1)}">${money(price)} ${escape(priceLabel)}</text>
  ${dates.map((i, n) => `<text class="date" x="${Math.min(plot - 30, Math.max(2, x(i))).toFixed(1)}" y="${H - 6}" text-anchor="${n === 0 ? "start" : n === 1 ? "middle" : "end"}">${escape(day(points[i]!.time))}</text>`).join("\n  ")}
</svg>`;
}

/** The expandable technicals for one holding: every timeframe the engine computed, as tabs. `details` and radio
 *  inputs, so there is no script — the page prints, and whatever is left open prints open. */
function technicals(symbol: string, levels: Levels, series: { daily: Point[]; weekly?: Point[] }, cost: number | null,
                    id: string, contracts: ReportContract[] = []): string {
  const frames = levels.frames;
  // One marker per DISTINCT strike, carrying the contracts it covers. Several expirations, and calls and puts, can
  // share a strike — drawing each separately stacks identical lines, and a label reading only "$130" would not say
  // which of them it belongs to. A strike whose terms are not comparable to the share price is deliberately absent:
  // its row says the strike and says why it is not drawn.
  const byStrike = new Map<number, string[]>();
  for (const c of contracts) {
    if (c.strike === null || c.strikeNotDrawn) continue;
    const held = byStrike.get(c.strike) ?? [];
    held.push(`${c.contracts}× ${expiryDay(c.expiry)}${c.right ? ` ${c.right}` : ""}${c.direction ? ` ${c.direction}` : ""}`);
    byStrike.set(c.strike, held);
  }
  const strikes = [...byStrike].map(([value, held]) => ({ value, label: `${money(value)} strike · ${held.join(", ")}` }));
  const pane = (frame: Frame) => {
    if (frame.unavailable) return `<div class="pane"><p class="note">${escape(frame.unavailable)}</p></div>`;
    const source = frame.bar === "week" ? series.weekly ?? [] : series.daily;
    const from = Math.max(0, source.findIndex(p => p.time >= frame.start));
    const bar = frame.bar === "week" ? "week" : "day";
    return `<div class="pane">${chart(source.slice(from), frame, levels.price, `${symbol} · ${frame.label}`, cost, priceNote(levels, true), strikes)}
      <p class="legend">${frame.sinceListing ? `<strong>Short window: this holds ${frame.sessions} ${bar}${frame.sessions === 1 ? "" : "s"} of trading${source[from] ? `, because the history available for ${escape(symbol)} starts ${escape(day(source[from]!.time))}` : ""} — later than this window opens, so it is not a full one.</strong> ` : ""}Measured on ${bar === "week" ? "weekly" : "daily"} bars: a ${bar} moves ${money(frame.atr)} on average, and that sets how wide these zones are. The nearest three zones on each side are drawn — shaded below the price is support, above it resistance — and each is labelled with how many ${bar}s reached it — trading into it, or within a small tolerance of it — without closing through. Consecutive ${bar}s each count, and the count is taken over the same bars the zone was built from, so it is a record of this window, not a score. A dashed box is a gap the price has not traded back into. Changing the tab changes the window the rules looked at, so the zones change with it.</p></div>`;
  };
  const selected = Math.max(0, frames.findIndex(x => x.timeframe === levels.defaultTimeframe));
  // The axis is the UNDERLYING's price. An option premium never goes on it, so the label says whose price this is —
  // "price, cost and levels" was ambiguous the moment a group had no shares to cost.
  const heading = `Underlying price, levels${cost === null ? "" : ", your share cost"}${strikes.length ? " and held strikes" : ""}`;
  return `<details class="technicals"><summary>${escape(heading)}<span class="chev" aria-hidden="true"></span></summary>
  <div class="tabs">
    ${frames.map((f, i) => `<input type="radio" name="tf-${id}" id="tf-${id}-${i}"${i === selected ? " checked" : ""}><label for="tf-${id}-${i}">${escape(f.label)}</label>`).join("\n    ")}
    <div class="panes">${frames.map(pane).join("\n")}</div>
  </div></details>`;
}

/** How a contract is named in a row: everything that identifies it, in the order it is spoken. An unidentified
 *  contract still gets a name from what the position knows — never a strike of 0 and never a blank. */
function contractName(c: ReportContract, symbol: string): string {
  const terms = c.strike !== null && c.right ? `${money(c.strike)} ${c.right}` : "contract";
  const side = c.direction ?? "";
  return `${symbol} ${expiryDay(c.expiry)} ${terms}${side ? ` · ${side}` : ""}`;
}
/** An expiry as a reader says it. Full date, not a shorthand: two contracts a year apart must not read alike. */
function expiryDay(expiry: string): string {
  const parsed = new Date(`${expiry}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? expiry
    : parsed.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** One contract, beneath its underlying.
 *
 *  The last two columns are the underlying's levels and belong to the group's own row, so a contract spans them with
 *  the one relationship that IS the contract's: where its strike sits against the stock. A strike is not a breakeven
 *  and is never described as one. */
function contractRow(c: ReportContract, symbol: string, price: number | null): string {
  const v = c.value;
  // The premium column is per quoted unit, like the stock's cost per share — the contract's own multiplier is named
  // only when it is not the standard 100, where a reader would otherwise multiply by the wrong number.
  const multiplier = c.multiplier !== null && c.multiplier !== 100 ? `<span class="dist">×${c.multiplier} per contract</span>` : "";
  // A magnitude with a direction in words, so no signed percentage ever sits in front of "below" — which reads as a
  // contradiction and, worse, as a number whose sign means something it does not.
  //
  // The reason is shown whenever there is one, not only when the strike is missing. A contract whose terms were
  // found but whose direction could not be read shows a dash in three money columns, and a dash with no sentence
  // beside it is the shape this report treats as a defect everywhere else.
  const placed = c.strike !== null && price !== null && price !== 0
    ? `strike ${money(c.strike)} is ${(Math.abs((c.strike - price) / price) * 100).toFixed(1)}% ${c.strike >= price ? "above" : "below"} the price`
      + (c.strikeNotDrawn ? ` · not drawn: ${escape(c.strikeNotDrawn)}` : "")
    : c.strike !== null ? `strike ${money(c.strike)}` : "";
  const strikeNote = [placed, c.note ? escape(c.note) : ""].filter(Boolean).join(" · ")
    || escape("contract details unavailable");
  return `<tr class="contract">
    <th scope="row">${escape(contractName(c, symbol))}</th>
    <td class="num">${c.contracts.toLocaleString("en-US")}${multiplier}</td>
    <td class="num">${money(c.averageCostPerShare)}</td>
    <td class="num">${c.mark === null ? "—" : money(c.mark)}${
      c.mark === null || !c.markAt ? "" : `<span class="dist">${escape(
        c.markSource === "close" ? `close ${day(c.markAt)}` : `mark ${easternTime(c.markAt)} ET`)}</span>`}</td>
    <td class="num">${v ? money(v.value, 0) : "—"}</td>
    <td class="num ${v?.gain == null ? "" : v.gain < 0 ? "down" : "up"}">${v?.gain === null || v === null ? "—" : money(v.gain, 0)}${
      v?.gainPctOfPremium == null ? "" : `<span class="dist">${percent(v.gainPctOfPremium)} of premium</span>`}</td>
    <td class="level" colspan="2">${strikeNote}</td>
  </tr>`;
}

function row(entry: ReportHolding, id: string): string {
  const { symbol: raw, holding, levels, series = { daily: [] }, unavailable, contracts = [] } = entry;
  const symbol = escape(raw);
  if (!levels || unavailable) {
    // No levels for the underlying. The contracts are still held and are still listed — the stock's price history is
    // what could not be read, not the account's positions.
    return `<tr class="holding${holding ? "" : " optionsonly"}"><th scope="row">${symbol}</th>
      <td class="num">${holding ? holding.shares.toLocaleString("en-US") : `<span class="dist">no shares</span>`}</td>
      <td class="num">${money(holding?.averageCost ?? null)}</td>
      <td class="num" colspan="5">${escape(unavailable ?? "no price history")}</td></tr>
      ${contracts.map(c => contractRow(c, raw, null)).join("\n")}`;
  }
  const frame = shown(levels), price = levels.price;
  // The group's money is the share position plus EVERY contract, signed. A short leg subtracts, which is the only way
  // the column can be added up — and two legs that offset net to nothing without either disappearing from the rows.
  //
  // "Every" is load-bearing, and getting it wrong is this project's oldest defect wearing new clothes. Summing only
  // the contracts that could be valued makes an empty list total zero, so a group of shares plus three contracts
  // nobody could price would print the share figure alone — identical on the page to a group whose contracts are
  // worth nothing, and short by however much they are actually worth. That is exactly how `overview()` once reported
  // a portfolio short by a whole account, by treating a null total as a zero. A total covers all of its parts or it
  // is unknown, so one unvaluable contract makes the group's figure null and the row says so.
  const shareValue = holding ? holding.shares * price : null;
  const shareCost = holding?.averageCost == null ? null : holding.averageCost * holding.shares;
  const valued = contracts.filter(c => c.value);
  const allValued = valued.length === contracts.length;
  const optionValue = allValued ? valued.reduce((n, c) => n + c.value!.value, 0) : null;
  const optionGain = allValued && valued.every(c => c.value!.gain !== null)
    ? valued.reduce((n, c) => n + c.value!.gain!, 0) : null;
  const value = optionValue === null ? null : shareValue === null && !contracts.length ? null : (shareValue ?? 0) + optionValue;
  const shareGain = shareCost === null || shareValue === null ? null : shareValue - shareCost;
  const gain = contracts.length === 0 ? shareGain
    : optionGain === null || (holding && shareGain === null) ? null : (shareGain ?? 0) + optionGain;
  // A percentage only where one denominator covers the whole figure. Premium and share cost are different
  // denominators, so a mixed group's percentage would be a number with no meaning behind it.
  const gainPct = contracts.length || shareCost === null || shareCost === 0 || shareGain === null
    ? null : (shareGain / shareCost) * 100;
  // Why the total above is a dash, on the line the dash is on. Each contract already says why IT has no value, but
  // a reader looking at the group's figure should not have to infer the cause from the rows beneath it.
  // Two different causes, and one word covered both: a contract with no price at all, and one priced but not
  // valuable because a field it needs could not be read. The row beneath says which; the group note should not
  // guess.
  const unvalued = contracts.filter(c => !c.value);
  const unpriced = unvalued.filter(c => c.mark === null).length;
  const why = unpriced === unvalued.length ? "not priced" : unpriced === 0 ? "not valued" : "not priced or valued";
  const unpricedNote = value !== null || !unvalued.length ? ""
    : `<span class="dist">${unvalued.length} of ${contracts.length} contract${contracts.length === 1 ? "" : "s"} ${why}</span>`;
  const { support, resistance, toSupport, toResistance } = nearest(frame, price);
  const away = atrsAway(frame, price);
  const near = away <= 1;
  const side = near ? (Math.abs(toSupport ?? Infinity) <= Math.abs(toResistance ?? Infinity) ? "support" : "resistance") : "";
  const zone = (z: Zone | undefined, distance: number | null) => z
    ? `<span class="zone">${money(z.lo)}–${z.hi.toFixed(2)}</span><span class="dist">${percent(distance)} · held ${z.tests}</span>`
    : "—";
  // With no shares there is no cell for the underlying's own price, and a contract's Price column is its PREMIUM —
  // putting the stock price there would be a category error. So the group's row carries the stock's price, its
  // provenance and its levels, and says plainly that no shares are held rather than showing a dash for a quantity.
  const shares = holding ? holding.shares.toLocaleString("en-US") : `<span class="dist">no shares</span>`;
  return `<tr class="holding${near ? " near" : ""}${holding ? "" : " optionsonly"}">
    <th scope="row">${symbol}${near ? `<span class="flag" title="Within one average daily range of this level">near ${side}</span>` : ""}</th>
    <td class="num">${shares}</td>
    <td class="num">${money(holding?.averageCost ?? null)}</td>
    <td class="num">${money(price)}<span class="dist">${escape(priceNote(levels))}</span></td>
    <td class="num">${money(value, 0)}${unpricedNote}</td>
    <td class="num ${gain === null ? "" : gain < 0 ? "down" : "up"}">${money(gain, 0)}${
      gainPct === null ? "" : `<span class="dist">${percent(gainPct)}</span>`}</td>
    <td class="level">${zone(support, toSupport)}</td>
    <td class="level">${zone(resistance, toResistance)}</td>
  </tr>
  ${contracts.map(c => contractRow(c, raw, price)).join("\n")}
  <tr class="expand"><td colspan="8">${
    // Beside the row, not inside the disclosure. A caveat folded into a collapsed section is not shown to anyone
    // reading the table, and print drops unopened sections entirely — so it would be absent from exactly the copy
    // someone keeps. The numbers it qualifies are on the line above it.
    levels.warnings.length ? `<p class="note">${levels.warnings.map(w => escape(w)).join(" ")}</p>` : ""
  }${technicals(raw, levels, series, holding?.averageCost ?? null, id, contracts)}</td></tr>`;
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
    distance(x) - distance(y) || x.symbol.localeCompare(y.symbol));
  const unpriced = rows.filter(r => !r.levels).length;
  const value = a.totals.value;
  // What the account value holds that this header has not named. The classes come from a frozen list, so anything
  // Robinhood folds into the total and Astra does not know about — pending deposits today, an eighth asset class
  // tomorrow — would otherwise vanish between the lines, which is the failure this whole change exists to end, one
  // level up from where it started. Shown rather than reconciled: nothing here asserts the parts must agree, only
  // what is left over. Needs both ends known, and only worth a line once it would not round to nothing.
  const itemized = a.totals.byClass.reduce((n, c) => n + c.value, 0) + (a.totals.cash ?? 0);
  const left = value === null || a.totals.cash === null ? null : value - itemized;
  const residual = left !== null && Math.abs(left) >= 0.5 ? left : null;
  const notes: string[] = [];
  if (a.skipped) notes.push(`${a.skipped} holding${a.skipped === 1 ? "" : "s"} could not be read and ${a.skipped === 1 ? "is" : "are"} not shown.`);
  if (a.truncated) notes.push("This account has more holdings than one report can page through; the rest are not shown.");
  // The header now names every class Robinhood reports a value for, so the gap can be named rather than lumped.
  // The table lists stocks; anything else the account holds is stated above it and said here in words.
  // What the table actually holds now, which decides everything this note may claim. Contracts are listed, so the
  // options class must not be named among the things that are NOT listed — the note said so while they sat on the
  // rows beneath it.
  const listed = rows.some(r => r.contracts?.length);
  const shares = rows.some(r => r.holding);
  const others = a.totals.byClass.filter(c => c.label !== "Stocks" && !(listed && c.label === "Options"));
  const contents = shares && listed ? "this account's stocks and option contracts"
    : listed ? "this account's option contracts" : "this account's stocks";
  if (others.length || listed) {
    // A colon list rather than a sentence: "options" is plural and "crypto" is not, so any is/are agreement is wrong
    // for one of them. The options entry, where it still appears, says what is known about the contracts behind the
    // figure — a number with no qualifier is a claim; these say which claim.
    const named = others.map(c => c.label === "Options" && a.options !== undefined
      ? `options (${money(c.value, 0)}, ${optionNote(a.options, c.value)})`
      : `${c.label.toLowerCase()} (${money(c.value, 0)})`).join(", ");
    const elsewhere = named ? ` Also counted in the account value above, but not listed here: ${named}.` : "";
    // With no rows there is no table below — it is suppressed, not empty — so a sentence pointing at one sends the
    // reader looking for something that is not on the page. And an empty list is not evidence of an empty account:
    // it is also what every row failing to parse produces, which is why the wording turns on `a.skipped` rather than
    // claiming from absence. Saying "holds no stocks" in the same paragraph that says holdings were dropped states
    // two different things as one fact.
    notes.push(rows.length
      ? `The table below lists ${contents}.${elsewhere}`
      : a.skipped || a.truncated
        ? `No positions could be read for this account, so none are listed.${named ? ` Counted in the account value above: ${named}.` : ""}`
        : `This account holds no stocks.${named ? ` Counted in the account value above, but not listed here: ${named}.` : ""}`);
  }
  // Listing the contracts took the options class out of `others`, and with it the only sentence that ever said the
  // contract read stopped early or dropped rows. The reader then sees N rows and takes them for the whole book —
  // which is worse than the count this note replaced, because rows look complete in a way a number does not.
  if (listed && typeof a.options === "object") {
    const { count, positions, skipped: dropped, truncated: more } = a.options;
    if (more) notes.push(`This account holds more contracts than one report can page through; beyond the ${count} listed below, the rest are not shown.`);
    if (dropped) notes.push(`${dropped} contract row${dropped === 1 ? "" : "s"} could not be read and ${dropped === 1 ? "is" : "are"} not listed — the ${count} below ${count === 1 ? "is" : "are"} what could be.`);
  }
  // What this can truthfully say changed with the header. It used to mean "excluded from the equities subtotal Astra
  // computed" — but that subtotal is gone, and the Stocks figure is now Robinhood's own, which counts these holdings.
  // Saying the total excludes them would misstate a money figure.
  // Two different facts, and one sentence used to cover both: a holding this report chose not to chart, and one
  // whose history could not be read. Blaming a price read that was never attempted sends a reader to the broker.
  const uncharted = rows.filter(r => !r.levels && r.unavailable?.startsWith("not charted")).length;
  const unreadable = unpriced - uncharted;
  if (uncharted) notes.push(`${uncharted} holding${uncharted === 1 ? "" : "s"} below ${uncharted === 1 ? "is" : "are"} not charted by this report, so ${uncharted === 1 ? "it shows" : "they show"} no value, gain or levels — ${uncharted === 1 ? "it is" : "they are"} still counted in the figures above.`);
  if (unreadable) notes.push(`${unreadable} holding${unreadable === 1 ? "" : "s"} below could not be priced, so ${unreadable === 1 ? "it shows" : "they show"} no value, gain or levels — ${unreadable === 1 ? "it is" : "they are"} still counted in the figures above.`);
  return `<section class="account">
  <header>
    <h2>${escape(a.label)}</h2>
    <dl class="totals">
      <div><dt>Account value</dt><dd>${money(value, 0)}</dd></div>
      ${a.totals.byClass.map(c => `<div><dt>${escape(c.label)}</dt><dd>${money(c.value, 0)}</dd></div>`).join("\n      ")}
      <div><dt>Cash</dt><dd>${money(a.totals.cash, 0)}</dd></div>${residual === null ? "" : `
      <div><dt>Not itemized</dt><dd>${money(residual, 0)}</dd></div>`}
    </dl>
  </header>
  ${notes.length ? `<p class="note">${notes.map(escape).join(" ")}</p>` : ""}
  ${rows.length === 0 ? "" : `<table>
    <thead><tr><th scope="col">Stock</th><th scope="col">Shares</th><th scope="col">Avg cost/share</th><th scope="col">Price</th>
      <th scope="col">Value</th><th scope="col">Unrealized P&amp;L</th><th scope="col">Support below</th><th scope="col">Resistance above</th></tr></thead>
    <tbody>${rows.map((r, i) => row(r, `${scope}-${i}`)).join("\n")}</tbody>
  </table>`}
</section>`;
}

/** What the chat should say out loud, so the model can speak in a paragraph and leave the detail in the report.
 *  Small on purpose: totals, the accounts, what is sitting on a level, and the extremes. */
export interface PortfolioOverview {
  asOf: string;
  /** `byClass` is per account and is NOT summed across them. Adding the same class across accounts is arithmetically
   *  fine, but it would be a portfolio figure Astra never computed or checked — say it per account, as it is given. */
  accounts: { label: string; value: number | null; holdings: number; byClass: { label: string; value: number }[] }[];
  totalValue: number | null;
  near: { symbol: string; side: "support" | "resistance"; zone: string; distancePct: number; tests: number }[];
  /** The extremes of unrealized percentage gain and loss — named for the arithmetic they are, not as "best" and
   *  "worst", which these were called until an external review pointed out that the chat reads these fields aloud.
   *  A product that will not characterize a position as good or bad on the page must not do it in the sentence
   *  either, and a ranking with a superlative on it is a judgement about what deserves attention.
   *
   *  The account is named because the same symbol held in two accounts has two different cost bases, so a bare
   *  symbol with a percentage beside it is ambiguous exactly where the number matters. */
  largestGains: { symbol: string; account: string; gainPct: number }[];
  largestLosses: { symbol: string; account: string; gainPct: number }[];
  unreadable: string[];
  /** Accounts whose totals could not be read. While this is non-empty the portfolio totals are null, not partial. */
  unreadableAccounts: string[];
}
export function overview(input: ReportInput): PortfolioOverview {
  const near: PortfolioOverview["near"] = [], gains: PortfolioOverview["largestGains"] = [], unreadable: string[] = [];
  // A total is the sum of every account or it is nothing. Treating one unreadable account as zero produces a number
  // that looks like the whole portfolio and is short by an account — and the chat is told to read this figure out.
  // A missing total is answerable ("I couldn't read one account"); a quietly understated one is not.
  const sum = (pick: (a: ReportAccount) => number | null) =>
    input.accounts.every(a => pick(a) !== null) ? input.accounts.reduce((n, a) => n + pick(a)!, 0) : null;
  for (const account of input.accounts) for (const entry of account.holdings) {
    const { symbol, holding, levels } = entry;
    if (!levels) { unreadable.push(symbol); continue; }
    const frame = shown(levels);
    // Share gains only. A contract's percentage is over its opening premium, which is a different denominator, and
    // ranking the two together would compare numbers that do not mean the same thing.
    if (holding?.averageCost) gains.push({ symbol, account: account.label,
      gainPct: (levels.price - holding.averageCost) / holding.averageCost * 100 });
    if (atrsAway(frame, levels.price) > 1) continue;
    const { support, resistance, toSupport, toResistance } = nearest(frame, levels.price);
    const closerToSupport = support && (!resistance || Math.abs(toSupport ?? Infinity) <= Math.abs(toResistance ?? Infinity));
    const zone = closerToSupport ? support : resistance;
    if (!zone) continue;
    near.push({ symbol, side: closerToSupport ? "support" : "resistance",
      zone: `${money(zone.lo)}–${zone.hi.toFixed(2)}`, distancePct: Number(((closerToSupport ? toSupport : toResistance) ?? 0).toFixed(1)), tests: zone.tests });
  }
  const ranked = [...gains].sort((a, b) => b.gainPct - a.gainPct).map(g => ({ ...g, gainPct: Number(g.gainPct.toFixed(1)) }));
  return { asOf: input.generatedAt.slice(0, 10),
    // byClass rides along so the chat can say "and $84,000 of that is options" without the report being open.
    accounts: input.accounts.map(a => ({ label: a.label, value: a.totals.value, holdings: a.holdings.length, byClass: a.totals.byClass })),
    totalValue: sum(a => a.totals.value),
    near, largestGains: ranked.slice(0, 3),
    largestLosses: ranked.slice(-3).reverse().filter(g => !ranked.slice(0, 3).includes(g)), unreadable,
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

/** Astra's mark, inlined. The page is served on loopback AND saved to disk by the "Save this page" link, so a
 *  favicon fetched from anywhere would be missing from exactly the copy someone keeps — and the page's own policy
 *  is `default-src 'none'` with `img-src data:`, which forbids fetching it in the first place. A data URI is the
 *  only form that satisfies both.
 *
 *  Held as a copy of `docs/assets/astra-mark.svg` rather than read from it: nothing in this module touches the
 *  filesystem, which is what lets the whole renderer be exercised without one. A test pins the two together. */
const ASTRA_MARK = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64" fill="none" role="img" aria-labelledby="title desc">
  <title id="title">Astra</title>
  <desc id="desc">A Japanese tanto-inspired dagger with a clipped point, terminal-green cutting edge, restrained guard, and diamond-wrapped graphite grip.</desc>
  <rect x="1" y="1" width="62" height="62" rx="16" fill="#10171C" stroke="#00FF88" stroke-opacity=".25"/>
  <g transform="rotate(40 32 32)">
    <path d="M38 6 37 37H28V17Z" fill="#194B39"/>
    <path d="M38 6 33 19 33 37H37Z" fill="#00FF88"/>
    <path d="M38 6 37 37" stroke="#BDFFE0" stroke-width="1"/>
    <path d="M28 17 38 6" stroke="#56FFB0" stroke-width="1"/>
    <rect x="27" y="35" width="11" height="4" rx=".8" fill="#859B9D"/>
    <rect x="23" y="39" width="19" height="3" rx="1" fill="#D3DEDD"/>
    <path d="M29 42H36V54L34 57H31L29 54Z" fill="#25343B" stroke="#72878C" stroke-width="1"/>
    <path d="m32.5 44 2 2-2 2-2-2Zm0 6 2 2-2 2-2-2Z" fill="#00FF88"/>
  </g>
</svg>`;
/** Percent-encoded rather than base64: an SVG data URI stays human-readable in the markup, so a reader viewing
 *  source can see exactly what the icon is instead of an opaque blob. Only the characters that would end the
 *  attribute or be read as a fragment are escaped. */
const ASTRA_ICON = `data:image/svg+xml,${ASTRA_MARK.replace(/[#%"'<>]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`).replace(/\s+/g, " ")}`;

/** The whole report. Self-contained: no network, no fonts to fetch, and one small script for the print button whose
 *  hash is named in the page's own policy, so nothing else can run even if something got into the markup. */
export function portfolioReport(input: ReportInput): string {
  const accounts = input.accounts.map((a, i) => account(a, i)).join("\n");
  const holdings = input.accounts.reduce((n, a) => n + a.holdings.length, 0);
  const script = SCRIPT;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Portfolio levels — ${escape(day(input.generatedAt.slice(0, 10)))}</title>
<link rel="icon" href="${ASTRA_ICON}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="content-security-policy" content="${REPORT_CSP}">
<style>
  :root { color-scheme: light dark;
    --ink: #10171c; --muted: #5a6b70; --rule: #d6dedc; --ground: #fbfcfc; --panel: #fff;
    --up: #10715a; --down: #b03a2c; --support: #0b7c75; --resistance: #a2650f;
    --support-fill: rgba(11,124,117,.13); --resistance-fill: rgba(162,101,15,.13); --strike: #6c4ab6; }
  @media (prefers-color-scheme: dark) { :root {
    --ink: #dce5e3; --muted: #8a9c9e; --rule: #24333a; --ground: #0d1316; --panel: #11191d;
    --up: #1fd286; --down: #e86a57; --support: #33c9be; --resistance: #e4a548;
    --support-fill: rgba(51,201,190,.16); --resistance-fill: rgba(228,165,72,.16); --strike: #b49be8; } }
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
  tr.contract > * { padding-top: 4px; font-size: 13px; color: var(--muted); }
  tr.contract th { font-weight: 500; padding-left: 22px; font-size: 13px; }
  tr.contract .num, tr.contract .level { color: var(--ink); }
  tr.contract .level { font-size: 11px; color: var(--muted); }
  /* An underlying held only in options has no share quantity to show, and a dash there reads as a failed read. */
  tr.optionsonly th { font-style: normal; }
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
  /* A held strike: the underlying's own axis, drawn differently from the zones so it is never read as one. */
  .chart .strike line { stroke: var(--strike); stroke-width: 1.2; stroke-dasharray: 7 3; }
  .chart .strike text { fill: var(--strike); }
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
      --up: #000; --down: #000; --support-fill: #eee; --resistance-fill: #e4e4e4; --strike: #444; }
    body { padding: 0; font-size: 11pt; }
    .actions { display: none; }
    .account { break-inside: auto; page-break-inside: auto; border: 0; padding: 0; margin-bottom: 18pt; }
    tr.holding, tr.contract { break-inside: avoid; page-break-inside: avoid; }
    tr.holding { break-after: avoid; page-break-after: avoid; }
    tr.expand { break-after: auto; page-break-after: auto; }
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
    <p class="asof">${[escape(day(input.generatedAt.slice(0, 10))), `${holdings} holding${holdings === 1 ? "" : "s"}`,
      escape(windowLabel(input)), "each price says which session it is from"].filter(Boolean).join(" · ")}</p>
  </div>
  <div class="actions">
    <button id="print" type="button">Print or save as PDF</button>
    <a id="save" download="portfolio-${escape(input.generatedAt.slice(0, 10))}.html" href="">Save this page</a>
  </div>
</header>
${accounts}
<footer>Every price says what it is. "Close" is that session's official closing price. "After hours", "pre-market" and
"last trade" are single trades later than the last close Robinhood has published — which is why one can appear here
before today's close does — and they are not closing prices. Distances are measured from the price shown to the
nearest edge of a zone. Support and resistance are computed by fixed rules from settled daily bars, or from weekly
bars on the five-year chart. No zone is drawn from a trade later than the last settled close, though a later price does
decide which of them are shown and which side of it they fall on. "Held 24" counts how many bars reached that zone —
entering it, or coming within a small tolerance — without closing through it: a record of what happened in this window,
not a probability that it happens again. A held strike is drawn against the underlying's price, and is not a breakeven. Nothing
here is a recommendation to buy or sell, and Astra places no orders.</footer>
<script>${script}</script>
</body></html>`;
}
