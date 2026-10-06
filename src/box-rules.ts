// The support-box strategy's rules, each written once, and the pure day scan that applies them (watch-only, v0.1: it
// finds and describes setups; it opens nothing). A rule returns its decision with the evidence the journal records, as
// in orb-rules.ts. Every number is a row in box-settings.ts. Timestamps: a candle is named by its START; "ends" is the
// moment it closes. The grid starts at 9:32 ET (when the opening range ends), as in the opening-range strategy.
import { addDays, isTradingDay, sessionTimes } from "./daily-history.ts";
import { sessionsBefore } from "./market-data.ts";
import { levels, parseLevelsSettings, type DailyBars, type Frame, type Zone } from "./levels.ts";
import { OPENING_RANGE_MINUTES } from "./orb-options.ts";
import { barCandleCloses, trailingAtr, type RuleDecision } from "./orb-rules.ts";
import type { BoxConfig } from "./box-settings.ts";

/** A minute bar as Robinhood sends it, with its volume. */
export interface BoxBar { begins_at: string; open_price: string; high_price: string; low_price: string; close_price: string; volume?: string; interpolated?: boolean }
/** A finished candle. `close` is null when it is not known: then no rule acts on the candle (ADR 0001). `high` and `low`
 *  are the extremes of what was seen: every minute bar offline, observed trades live (so live ranges can be narrower). */
export interface Candle { start: number; end: number; high: number; low: number; close: number | null }
export type SupportKind = "broken_resistance" | "breakout_high" | "average" | "anchored_vwap";
/** A level a box may sit on: a point (lo = hi) or a zone. */
export interface Support { kind: SupportKind; label: string; lo: number; hi: number }

const iso = (ms: number) => new Date(ms).toISOString();
/** Levels are journaled to 1/10,000 of a dollar, never with float noise. */
const shown = (v: number) => Math.round(v * 1e4) / 1e4;
const ratio = (v: number) => Math.round(v * 1e3) / 1e3;
const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sma = (closes: readonly number[], period: number, end = closes.length) => end < period ? null : mean(closes.slice(end - period, end));
/** Exponential average of the closes, seeded with the simple average of the first `period` (the whole history converges it). */
const ema = (closes: readonly number[], period: number): number | null => {
  if (closes.length < period * 2) return null;
  let e = mean(closes.slice(0, period)); const k = 2 / (period + 1);
  for (const x of closes.slice(period)) e = x * k + e * (1 - k);
  return e;
};
const atrOf = (daily: DailyBars, n: number) =>
  trailingAtr(daily.time.map((_, i) => ({ high: daily.high[i]!, low: daily.low[i]!, close: daily.close[i]! })), n);

// ---- Runaway gate (daily bars strictly before the day). "All my strategies are only for runaway stocks."

/** The trading session just before `date`. */
const previousSession = (date: string): string => { let d = addDays(date, -1); while (!isTradingDay(d)) d = addDays(d, -1); return d; };
/** The levels frame the gate and the supports read: the engine's default (longest usable daily) frame, or null. */
export function levelsFrame(daily: DailyBars): Frame | null {
  const lv = levels(daily, parseLevelsSettings());
  return lv.frames.find(f => f.timeframe === lv.defaultTimeframe && !f.unavailable) ?? null;
}
/** Zones the price closed above (by the engine's own break rules) and has not given back. */
const brokenAbove = (frame: Frame | null): Zone[] =>
  [...(frame?.resistance ?? []), ...(frame?.support ?? [])].filter(z => z.broke?.direction === "above" && !z.broke.backInsideOn);

/** Whether a stock is a runaway: the last close stands above its rising short and long averages, within a set distance of
 *  its high of the last few months, and a daily close went through a prior resistance zone recently. Each check is
 *  journaled with its numbers, so a review sees which one failed. */
export type GateDecision = RuleDecision<"runaway"> | { fired: false; reason: "unavailable"; unavailable: "stale_daily_history" | "not_enough_daily_history"; evidence: Record<string, unknown> };
export function runawayGate(daily: DailyBars, config: BoxConfig, frame: Frame | null = levelsFrame(daily)): GateDecision {
  const n = daily.close.length, price = daily.close[n - 1] ?? null;
  const checks: { name: string; pass: boolean; [k: string]: unknown }[] = [];
  const need = Math.max(config.longAveragePeriod + config.risingLookbackSessions, config.highLookbackSessions);
  const previous = previousSession(config.date);
  if (n && daily.time[n - 1] !== previous) return { fired: false, reason: "unavailable", unavailable: "stale_daily_history", evidence: { sessions: n, lastSession: daily.time[n - 1] ?? null, expected: previous } };
  if (n < need || price === null) return { fired: false, reason: "unavailable", unavailable: "not_enough_daily_history", evidence: { sessions: n, needSessions: need } };
  for (const [name, period] of [["short", config.shortAveragePeriod], ["long", config.longAveragePeriod]] as const) {
    const now = sma(daily.close, period)!, before = sma(daily.close, period, n - config.risingLookbackSessions)!;
    checks.push({ name: `${name}Average`, pass: price > now && now > before, period, average: shown(now), averageEarlier: shown(before), price });
  }
  const high = Math.max(...daily.high.slice(-config.highLookbackSessions)), floor = high * (1 - config.maxBelowHighFraction);
  checks.push({ name: "nearHigh", pass: price >= floor, high: shown(high), lookbackSessions: Math.min(n, config.highLookbackSessions), floor: shown(floor), price });
  const broke = brokenAbove(frame).filter(z => z.broke!.barsSince <= config.breakoutLookbackSessions);
  checks.push({ name: "brokeResistance", pass: broke.length > 0, levelsFrame: frame?.timeframe ?? null,
    zones: broke.map(z => ({ lo: shown(z.lo), hi: shown(z.hi), on: z.broke!.on, closes: z.broke!.closes, barsSince: z.broke!.barsSince })) });
  return { fired: checks.every(c => c.pass), reason: "runaway", evidence: { asOf: daily.time[n - 1], checks } };
}

// ---- Supports

/** Supports known before the open: zones the price broke above (and the high of the session it broke on), and the averages. */
export function staticSupports(daily: DailyBars, config: BoxConfig, frame: Frame | null = levelsFrame(daily)): Support[] {
  const out: Support[] = [];
  if (config.useBrokenResistance) for (const z of brokenAbove(frame)) {
    out.push({ kind: "broken_resistance", label: `zone broken ${z.broke!.on}`, lo: z.lo, hi: z.hi });
    const i = daily.time.indexOf(z.broke!.on);
    if (i >= 0) out.push({ kind: "breakout_high", label: `high of ${z.broke!.on}`, lo: daily.high[i]!, hi: daily.high[i]! });
  }
  // The daily averages a stock may bounce off (founder, 2026-10-06: "some stocks do it at 20/21 ema/sma"; "the same rules apply to
  // stocks which find buyers at 10ema/sma"), recomputed each morning
  // from the history before the day. Separate from the runaway gate's averages, which ask a different question.
  const periods = [...new Set([config.averageSupportFastPeriod, config.averageSupportShortPeriod, config.averageSupportLongPeriod])].filter(p => p > 0).sort((a, b) => a - b);
  if (config.useAverages) for (const period of periods) {
    if (config.averageSupportKind !== 1) { const v = sma(daily.close, period); if (v !== null) out.push({ kind: "average", label: `${period}-day SMA`, lo: v, hi: v }); }
    if (config.averageSupportKind !== 0) { const v = ema(daily.close, period); if (v !== null) out.push({ kind: "average", label: `${period}-day EMA`, lo: v, hi: v }); }
  }
  return out;
}
/** A minute bar reduced to what a VWAP needs. */
export interface VwapBar { at: number; typical: number; volume: number }
/** Regular-session minute bars, real ones only (a padded or zero-volume bar is not a trade). */
export function vwapBars(bars: readonly BoxBar[]): VwapBar[] {
  return bars.flatMap(b => {
    const at = Date.parse(b.begins_at), h = +b.high_price, l = +b.low_price, c = +b.close_price, volume = +(b.volume ?? NaN);
    return b.interpolated === true || !Number.isFinite(at) || ![h, l, c].every(v => Number.isFinite(v) && v > 0) || !(volume > 0) ? [] : [{ at, typical: (h + l + c) / 3, volume }];
  });
}
/** VWAPs anchored at the regular-session open 1..N sessions back, through the end of the prior session, plus today's
 *  finished minutes up to `asOf` when the setting says so. Nothing later than `asOf` is ever read. */
export function anchoredVwaps(bars: readonly VwapBar[], daily: DailyBars, config: BoxConfig, asOf: number): Support[] {
  if (!config.useAnchoredVwaps) return [];
  const out: Support[] = [], n = daily.time.length;
  for (let k = 1; k <= config.vwapMaxSessionsBack && n - k >= 0; k++) {
    let pv = 0, v = 0;
    // An anchored VWAP needs every session from its anchor to the prior close: a missing one would silently anchor it later.
    const complete = daily.time.slice(n - k).every(day => { const { open, close } = sessionTimes(day); return bars.some(b => b.at >= open && b.at < close); });
    if (!complete) continue;
    for (const day of [...daily.time.slice(n - k), config.date]) {
      const { open, close } = sessionTimes(day), until = day === config.date ? (config.vwapIncludesToday ? Math.min(asOf, close) : open) : close;
      for (const b of bars) if (b.at >= open && b.at + 60000 <= until) { pv += b.typical * b.volume; v += b.volume; }
    }
    if (v > 0) out.push({ kind: "anchored_vwap", label: `VWAP from ${daily.time[n - k]} open`, lo: pv / v, hi: pv / v });
  }
  return out;
}
/** The support a box low rests on: a support at or below the box low (`supportSlackAtr`, default 0, is the only tolerance for one above
 *  it: a level above the box low is resistance), and no further under it than `supportReachAtr`. A zone whose body contains the box low
 *  counts. The nearest one is returned. */
export function supportUnderBox(boxLow: number, supports: readonly Support[], atr: number, config: BoxConfig): RuleDecision<"at_support"> & { support: Support | null } {
  const reach = config.supportReachAtr * atr, slack = config.supportSlackAtr * atr;
  const near = supports.filter(s => boxLow >= s.lo - slack && boxLow <= s.hi + reach)
    .sort((a, b) => Math.abs(boxLow - Math.min(Math.max(boxLow, a.lo), a.hi)) - Math.abs(boxLow - Math.min(Math.max(boxLow, b.lo), b.hi)))[0] ?? null;
  return { fired: near !== null, reason: "at_support", support: near,
    evidence: { boxLow: shown(boxLow), reach: shown(reach), slack: shown(slack), support: near && { kind: near.kind, label: near.label, lo: shown(near.lo), hi: shown(near.hi) },
      cluster: supportCluster(boxLow, supports, atr, config) } };
}
/** Context, read by no rule: every support within reach of the box low on EITHER side (a level a few cents above it is still part of the
 *  picture), and how tightly the daily averages within that reach sit together, in ATRs. Several supports in one place marked the founder's low-risk entries. */
export function supportCluster(boxLow: number, supports: readonly Support[], atr: number, config: BoxConfig) {
  const reach = config.supportReachAtr * atr;
  const near = supports.filter(s => boxLow >= s.lo - reach && boxLow <= s.hi + reach);
  // Spread over the averages IN the cluster (within reach), not every average: a 10-day far above a 20/21 cluster says nothing about it.
  const averages = near.filter(s => s.kind === "average").map(s => s.lo);
  // A level above the box low is in the picture but is not the box's support (it is resistance until the price closes over it): it is
  // flagged `above`, and counted apart from the levels at or below the low.
  // Distance from the box low to the NEAREST edge of the level (0 for a zone that spans the low), so its sign always agrees with `above`.
  const levels = near.map(s => { const edge = Math.min(Math.max(boxLow, s.lo), s.hi);
    return { label: s.label, level: shown((s.lo + s.hi) / 2), fromBoxLowAtr: ratio((edge - boxLow) / atr), above: s.lo > boxLow }; });
  return { withinReach: levels.length, atOrBelow: levels.filter(l => !l.above).length, above: levels.filter(l => l.above).length, levels,
    averagesSpreadAtr: averages.length > 1 ? ratio((Math.max(...averages) - Math.min(...averages)) / atr) : null };
}

// ---- Candles. Offline candles come from minute bars; the live runtime builds the same shape from observed trades.

/** Candles of the day from minute bars, on the grid from 9:32: only finished ones. A candle missing any of its minutes
 *  (or with a padded one) has close = null: its range cannot be trusted and no rule acts on it. */
export function barCandles(bars: readonly BoxBar[], date: string, candleMinutes: number): Candle[] {
  const { open, close } = sessionTimes(date), gridStart = open + OPENING_RANGE_MINUTES * 60000, length = candleMinutes * 60000;
  const real = bars.flatMap(b => {
    const at = Date.parse(b.begins_at), h = +b.high_price, l = +b.low_price, c = +b.close_price;
    return b.interpolated === true || at < gridStart || at >= close || ![h, l, c].every(Number.isFinite) ? [] : [{ at, high: h, low: l, close: c }];
  });
  if (!real.length) return [];
  const closes = new Map(barCandleCloses(real, gridStart, candleMinutes).map(c => [c.end, c.close]));
  // Only candles that have finished: the last bar must be the candle's last minute or later, so a candle still forming is never emitted.
  const lastEnd = gridStart + Math.floor((Math.max(...real.map(b => b.at)) + 60000 - gridStart) / length) * length, out: Candle[] = [];
  for (let end = gridStart + length; end <= lastEnd; end += length) {
    const inside = real.filter(b => b.at >= end - length && b.at < end), whole = new Set(inside.map(b => b.at)).size === candleMinutes;
    if (!inside.length) { out.push({ start: end - length, end, high: NaN, low: NaN, close: null }); continue; }
    out.push({ start: end - length, end, high: Math.max(...inside.map(b => b.high)), low: Math.min(...inside.map(b => b.low)),
      close: whole ? closes.get(end) ?? null : null });
  }
  return out;
}

// ---- The box and its contraction.

const height = (cs: readonly Candle[]) => Math.max(...cs.map(c => c.high)) - Math.min(...cs.map(c => c.low));
/** Volatility shrinks: the mean candle range of the box's second half against the mean range of the candles just before
 *  it. Not evaluable (not fired) without enough candles before the box. */
/** The candles a box is measured against: the session so far before it, or the few just before it (contractionBaseline). Unobserved
 *  candles are left out of the session baseline (a gap earlier in the day never blocks a later box). */
export function beforeBox(cs: readonly Candle[], start: number, config: BoxConfig): Candle[] {
  return config.contractionBaseline === 1 ? cs.slice(0, start).filter(c => c.close !== null && Number.isFinite(c.high - c.low))
    : cs.slice(Math.max(0, start - config.contractionLookbackCandles), start);
}
export function contraction(box: readonly Candle[], before: readonly Candle[], config: BoxConfig): RuleDecision<"contraction"> {
  if (before.length < config.contractionLookbackCandles || box.length < 2 || [...box, ...before].some(c => c.close === null || !Number.isFinite(c.high - c.low)))
    return { fired: false, reason: "contraction", evidence: { evaluable: false, candlesBefore: before.length, needed: config.contractionLookbackCandles } };
  const second = box.slice(box.length - Math.floor(box.length / 2)), secondMean = mean(second.map(c => c.high - c.low)), beforeMean = mean(before.map(c => c.high - c.low));
  const r = secondMean / beforeMean;
  return { fired: beforeMean > 0 && r <= config.contractionMaxRatio, reason: "contraction",
    evidence: { evaluable: true, secondHalfMean: shown(secondMean), beforeMean: shown(beforeMean), ratio: ratio(r), maxRatio: config.contractionMaxRatio, secondHalfCandles: second.length } };
}

export interface BoxLevels { start: number; end: number; high: number; low: number }
export interface BoxRecord {
  status: "live" | "decided" | "voided";
  box: { start: string; end: string; high: number; low: number; height: number; heightToAtr: number; candles: number; wickOutsideCandles: number };
  support: unknown;
  /** Context read by no rule: every support within reach of the box low, either side, and how tightly the daily averages sit. */
  cluster: unknown;
  /** The box low when the box formed (the live low can later extend under it within the height limit); the support was judged against this. */ lowAtFormation: number; formedAt: string; contractionAtFormation: Record<string, unknown>; contraction: Record<string, unknown>;
  decision: { direction: "up" | "down"; candleStart: string; candleEnd: string; close: number } | null;
  voided: { reason: "candle_unobserved"; candleStart: string } | null;
  /** Long-only. Journaled for an up decision, never opened in this version. */
  entries: { A: Entry; B: Entry; stop: number } | null;
}
export interface Entry { price: number; shares: number; riskPerShare: number; notional: number }

/** Entry price, stop and the shares that risk the set dollars: floor(risk / (entry - stop)); zero when it does not fit. */
export function sizedEntry(price: number, stop: number, config: BoxConfig): Entry {
  // In 1/10,000 of a dollar, so 100.42 - 100.32 is exactly 10 cents (not 10.000000000000853) and an entry priced at a half cent keeps it.
  const perShare = Math.round(price * 1e4) - Math.round(stop * 1e4), shares = perShare > 0 ? Math.floor(config.riskCents * 100 / perShare) : 0;
  return { price: shown(price), shares, riskPerShare: perShare / 1e4, notional: shown(shares * price) };
}

/** Why a day cannot be scanned at all: the inputs are missing or stale, which is not the same as a stock failing a rule. */
export interface Unavailable { reason: "stale_daily_history" | "not_enough_daily_history" | "no_atr"; evidence: Record<string, unknown> }
/** What every scan of a day starts from, however the candles arrive (offline minute bars or the live run): the daily history
 *  cut to the sessions before the day, the runaway verdict (null when the gate is off: the listed stocks are taken to be runaways
 *  already, and nothing says otherwise), the ATR and the supports known before the open. A history that is stale or too short is
 *  `unavailable`, never a failed gate. */
export interface DayHead { daily: DailyBars; gate: "on" | "off"; runaway: RuleDecision<"runaway"> | null; atr: number | null; supports: Support[]; unavailable: Unavailable | null }
export function prepareDay(dailyAll: DailyBars, config: BoxConfig): DayHead {
  const daily = sessionsBefore(dailyAll, config.date), n = daily.time.length, gate = config.useRunawayGate ? "on" as const : "off" as const;
  const head = { daily, gate, runaway: null as RuleDecision<"runaway"> | null, atr: null as number | null, supports: [] as Support[] };
  const previous = previousSession(config.date);
  if (n === 0 || daily.time[n - 1] !== previous) return { ...head, unavailable: { reason: "stale_daily_history", evidence: { sessions: n, lastSession: daily.time[n - 1] ?? null, expected: previous } } };
  const frame = levelsFrame(daily);
  if (gate === "on") {
    const need = Math.max(config.longAveragePeriod + config.risingLookbackSessions, config.highLookbackSessions);
    if (n < need) return { ...head, unavailable: { reason: "not_enough_daily_history", evidence: { sessions: n, needSessions: need, for: "runaway gate" } } };
    const gated = runawayGate(daily, config, frame);
    if (gated.reason === "unavailable") return { ...head, unavailable: { reason: gated.unavailable, evidence: gated.evidence } };
    head.runaway = gated;
    if (!head.runaway.fired) return { ...head, unavailable: null };
  }
  const atr = atrOf(daily, config.atrPeriod);
  if (atr === null) return { ...head, unavailable: { reason: "no_atr", evidence: { sessions: n, needSessions: config.atrPeriod + 1 } } };
  return { ...head, atr, supports: staticSupports(daily, config, frame), unavailable: null };
}

export interface DayScan {
  date: string; status: "scanned" | "not_runaway" | "unavailable" | "no_supports" | "no_candles";
  gate: "on" | "off"; runaway: RuleDecision<"runaway"> | null; unavailable: Unavailable | null; atr: number | null; supports: Support[]; candles: number; boxes: BoxRecord[];
}
/** Scans one day for boxes. `bars` are minute bars with volume covering up to the last few sessions through the day (the
 *  sessions before `config.date` anchor the VWAPs; the day's own bars make the candles). `daily` is split-adjusted
 *  history; sessions on or after the day are dropped. A candle sees only what had finished by its end. At most one box is
 *  live at a time; after one is decided or voided the search starts again after it, so a day may hold several. */
export function scanDay(bars: readonly BoxBar[], dailyAll: DailyBars, config: BoxConfig): DayScan {
  const { daily, gate, runaway, unavailable, atr, supports: fixed } = prepareDay(dailyAll, config);
  const blank = { date: config.date, gate, runaway, unavailable, atr, supports: [] as Support[], candles: 0, boxes: [] as BoxRecord[] };
  if (unavailable) return { ...blank, status: "unavailable" };
  if (runaway && !runaway.fired) return { ...blank, status: "not_runaway" };
  if (atr === null) return { ...blank, status: "unavailable", unavailable: { reason: "no_atr", evidence: {} } };
  const candles = barCandles(bars, config.date, config.candleMinutes), vbars = vwapBars(bars);
  if (!candles.length) return { ...blank, supports: fixed, status: "no_candles" };
  const supportsAt = (asOf: number) => [...fixed, ...anchoredVwaps(vbars, daily, config, asOf)];
  if (!supportsAt(candles[0]!.end).length) return { ...blank, status: "no_supports", candles: candles.length };
  return { ...blank, supports: supportsAt(candles[0]!.start), candles: candles.length, status: "scanned", boxes: scanBoxes(candles, supportsAt, atr, config) };
}

/** The box search over a day's candles, offline: the incremental scanner fed every candle in turn. */
export function scanBoxes(candles: readonly Candle[], supportsAt: (asOf: number) => Support[], atr: number, config: BoxConfig): BoxRecord[] {
  const scanner = new BoxScanner(atr, config), out: BoxRecord[] = [];
  for (const c of candles) for (const e of scanner.push(c, supportsAt)) if (e.type !== "formed") out.push(e.record);
  const live = scanner.live(); if (live) out.push(live);
  return out;
}

interface LiveBox { from: number; to: number; high: number; low: number; lowAtFormation: number; wicks: number; support: unknown; cluster: unknown; formedAt: number; atFormation: Record<string, unknown> }
/** A box the scanner has just formed, decided or voided. */
export interface BoxEvent { type: "formed" | "decided" | "voided"; record: BoxRecord }
/** Thrown by a `supportsAt` that cannot answer yet (the data it needs has not arrived). The scanner leaves its state exactly as
 *  it was before the candle, so the same candle can be pushed again later. */
export class NeedsData extends Error { what: string; constructor(what: string) { super(what); this.what = what; this.name = "NeedsData"; } }

/** The incremental box search (see the settings rows for every number). Candles are pushed in order, one per grid slot.
 *
 *  A candidate box starts as the first run of exactly `minBoxMinutes` of candles whose height fits under the limit, and
 *  grows to the right while it still fits; it never reaches back for earlier candles that happen to fit. It FORMS the first
 *  time the box low rests on a support and the contraction holds. Once formed, each new candle is judged in this order:
 *  its close unknown voids the box; its close above the box high or below its low DECIDES it, before any extension, so
 *  a breakout candle that would still fit under the limit is not swallowed; otherwise its high and low extend the box,
 *  each side only while the box stays within the limit (a wick past it is counted, never a bound). A formed box is sticky:
 *  nothing later rewrites it. */
export class BoxScanner {
  #candles: Candle[] = []; #floor = 0; #pending: number | null = null; #limit: number; #minCandles: number;
  #live: LiveBox | null = null;
  #atr: number; #config: BoxConfig;
  constructor(atr: number, config: BoxConfig) {
    this.#atr = atr; this.#config = config; this.#limit = config.maxBoxHeightAtr * atr; this.#minCandles = Math.ceil(config.minBoxMinutes / config.candleMinutes);
  }
  get candleCount() { return this.#candles.length; }
  #boxOf(l: LiveBox) {
    const cs = this.#candles;
    return { start: iso(cs[l.from]!.start), end: iso(cs[l.to]!.end), high: shown(l.high), low: shown(l.low), height: shown(l.high - l.low),
      heightToAtr: ratio((l.high - l.low) / this.#atr), candles: l.to - l.from + 1, wickOutsideCandles: l.wicks };
  }
  #record(l: LiveBox, status: BoxRecord["status"], extra: Partial<BoxRecord>): BoxRecord {
    const cs = this.#candles, c = this.#config, inside = cs.slice(l.from, l.to + 1), before = beforeBox(cs, l.from, c);
    return { status, box: this.#boxOf(l), support: l.support, cluster: l.cluster, lowAtFormation: shown(l.lowAtFormation), formedAt: iso(l.formedAt), contractionAtFormation: l.atFormation,
      contraction: { ...contraction(inside, before, c).evidence }, decision: null, voided: null, entries: null, ...extra };
  }
  /** The box still open, as it stands now. */
  live(): BoxRecord | null { return this.#live ? this.#record(this.#live, "live", {}) : null; }
  push(c: Candle, supportsAt: (asOf: number) => Support[]): BoxEvent[] {
    const saved = { floor: this.#floor, pending: this.#pending };
    this.#candles.push(c);
    try { return this.#step(c, supportsAt); }
    catch (error) { this.#candles.pop(); this.#floor = saved.floor; this.#pending = saved.pending; throw error; }
  }
  #step(c: Candle, supportsAt: (asOf: number) => Support[]): BoxEvent[] {
    const cs = this.#candles, i = cs.length - 1, config = this.#config, limit = this.#limit, l = this.#live;
    if (l) {
      if (c.close === null) return this.#end(l, "voided", { voided: { reason: "candle_unobserved", candleStart: iso(c.start) } }, i);
      if (c.close > l.high || c.close < l.low) {
        const up = c.close > l.high, stop = l.low, boxHeight = l.high - l.low;
        return this.#end(l, "decided", { decision: { direction: up ? "up" : "down", candleStart: iso(c.start), candleEnd: iso(c.end), close: shown(c.close) },
          entries: up ? { A: sizedEntry(l.low + config.entryAFractionOfBox * boxHeight, stop, config), B: sizedEntry(c.close, stop, config), stop: shown(stop) } : null }, i);
      }
      // Each side extends on its own while the box stays within the limit; a side that would break it is a wick, counted only.
      const high = Math.max(l.high, c.high), low = Math.min(l.low, c.low);
      let wick = false;
      if (high > l.high) { if (high - l.low <= limit) l.high = high; else wick = true; }
      if (low < l.low) { if (l.high - low <= limit) l.low = low; else wick = true; }
      if (wick) l.wicks++;
      l.to = i; return [];
    }
    if (c.close === null) { this.#floor = i + 1; this.#pending = null; return []; }
    const minCandles = this.#minCandles;
    if (this.#pending !== null && height(cs.slice(this.#pending, i + 1)) > limit) this.#pending = null;
    if (this.#pending === null && i - minCandles + 1 >= this.#floor && height(cs.slice(i - minCandles + 1, i + 1)) <= limit) this.#pending = i - minCandles + 1;
    const pending = this.#pending;
    if (pending === null || i - pending + 1 < minCandles) return [];
    // A candle that closes beyond the run before it may be that run's breakout, so it cannot be the candle on which the box FORMS. It stays in
    // the window (it still fits under the height limit, which is checked above) and the box can form on the next candle; discarding the
    // window would lose a still-tight consolidation to one mild new high.
    const run = cs.slice(pending, i);
    if (run.length && (c.close > Math.max(...run.map(x => x.high)) || c.close < Math.min(...run.map(x => x.low)))) return [];
    const inside = cs.slice(pending, i + 1), low = Math.min(...inside.map(x => x.low)), high = Math.max(...inside.map(x => x.high));
    const squeeze = contraction(inside, beforeBox(cs, pending, config), config);
    // Supports are asked for only once the box is tight and contracting (a caller may have to fetch data to answer).
    if (!squeeze.fired) return [];
    const at = supportUnderBox(low, supportsAt(c.end), this.#atr, config);
    if (!at.fired) return [];
    this.#live = { from: pending, to: i, high, low, lowAtFormation: low, wicks: 0, support: at.evidence.support, cluster: at.evidence.cluster, formedAt: c.end, atFormation: { ...squeeze.evidence } };
    return [{ type: "formed", record: this.#record(this.#live, "live", {}) }];
  }
  #end(l: LiveBox, status: "decided" | "voided", extra: Partial<BoxRecord>, i: number): BoxEvent[] {
    const record = this.#record(l, status, extra);
    this.#live = null; this.#floor = i + 1; this.#pending = null;
    return [{ type: status, record }];
  }
}
