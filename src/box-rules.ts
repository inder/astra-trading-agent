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
export function runawayGate(daily: DailyBars, config: BoxConfig, frame: Frame | null = levelsFrame(daily)): RuleDecision<"runaway"> {
  const n = daily.close.length, price = daily.close[n - 1] ?? null;
  const checks: { name: string; pass: boolean; [k: string]: unknown }[] = [];
  const need = Math.max(config.longAveragePeriod + config.risingLookbackSessions, config.highLookbackSessions);
  const previous = previousSession(config.date);
  if (n && daily.time[n - 1] !== previous) return { fired: false, reason: "runaway", evidence: { sessions: n, unavailable: "daily history does not end at the previous session", lastSession: daily.time[n - 1] ?? null, expected: previous } };
  if (n < need || price === null) return { fired: false, reason: "runaway", evidence: { sessions: n, needSessions: need, unavailable: "not enough daily history" } };
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
  if (config.useAverages) for (const period of [config.shortAveragePeriod, config.longAveragePeriod]) {
    const v = sma(daily.close, period); if (v !== null) out.push({ kind: "average", label: `${period}-session average`, lo: v, hi: v });
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
    for (const day of [...daily.time.slice(n - k), config.date]) {
      const { open, close } = sessionTimes(day), until = day === config.date ? (config.vwapIncludesToday ? Math.min(asOf, close) : open) : close;
      for (const b of bars) if (b.at >= open && b.at + 60000 <= until) { pv += b.typical * b.volume; v += b.volume; }
    }
    if (v > 0) out.push({ kind: "anchored_vwap", label: `VWAP from ${daily.time[n - k]} open`, lo: pv / v, hi: pv / v });
  }
  return out;
}
/** The support a box low rests on: at most `supportSlackAtr` below its bottom and `supportReachAtr` above its top. The nearest
 *  one is returned. A box low further below the support than the slack is not at support. */
export function supportUnderBox(boxLow: number, supports: readonly Support[], atr: number, config: BoxConfig): RuleDecision<"at_support"> & { support: Support | null } {
  const reach = config.supportReachAtr * atr, slack = config.supportSlackAtr * atr;
  const near = supports.filter(s => boxLow >= s.lo - slack && boxLow <= s.hi + reach)
    .sort((a, b) => Math.abs(boxLow - Math.min(Math.max(boxLow, a.lo), a.hi)) - Math.abs(boxLow - Math.min(Math.max(boxLow, b.lo), b.hi)))[0] ?? null;
  return { fired: near !== null, reason: "at_support", support: near,
    evidence: { boxLow: shown(boxLow), reach: shown(reach), slack: shown(slack), support: near && { kind: near.kind, label: near.label, lo: shown(near.lo), hi: shown(near.hi) } } };
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
  support: unknown; formedAt: string; contractionAtFormation: Record<string, unknown>; contraction: Record<string, unknown>;
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

export interface DayScan {
  date: string; status: "scanned" | "not_runaway" | "no_atr" | "no_supports" | "no_candles";
  runaway: RuleDecision<"runaway">; atr: number | null; supports: Support[]; candles: number; boxes: BoxRecord[];
}
/** Scans one day for boxes. `bars` are minute bars with volume covering up to the last few sessions through the day (the
 *  sessions before `config.date` anchor the VWAPs; the day's own bars make the candles). `daily` is split-adjusted
 *  history; sessions on or after the day are dropped. A candle sees only what had finished by its end. At most one box is
 *  live at a time; after one is decided or voided the search starts again after it, so a day may hold several. */
export function scanDay(bars: readonly BoxBar[], dailyAll: DailyBars, config: BoxConfig): DayScan {
  const daily = sessionsBefore(dailyAll, config.date), frame = levelsFrame(daily), runaway = runawayGate(daily, config, frame);
  const blank = { date: config.date, runaway, atr: null as number | null, supports: [] as Support[], candles: 0, boxes: [] as BoxRecord[] };
  if (!runaway.fired) return { ...blank, status: "not_runaway" };
  const atr = atrOf(daily, config.atrPeriod);
  if (atr === null) return { ...blank, status: "no_atr" };
  const fixed = staticSupports(daily, config, frame), candles = barCandles(bars, config.date, config.candleMinutes), vbars = vwapBars(bars);
  if (!candles.length) return { ...blank, atr, supports: fixed, status: "no_candles" };
  const supportsAt = (asOf: number) => [...fixed, ...anchoredVwaps(vbars, daily, config, asOf)];
  if (!supportsAt(candles[0]!.end).length) return { ...blank, atr, status: "no_supports", candles: candles.length };
  return { ...blank, atr, supports: supportsAt(candles[0]!.start), candles: candles.length, status: "scanned", boxes: scanBoxes(candles, supportsAt, atr, config) };
}

/** The box search over a day's candles (see the settings rows for every number).
 *
 *  A candidate box starts as the first run of exactly `minBoxMinutes` of candles whose height fits under the limit, and
 *  grows to the right while it still fits; it never reaches back for earlier candles that happen to fit. It FORMS the first
 *  time the box low rests on a support and the contraction holds. Once formed, each new candle is judged in this order:
 *  its close unknown voids the box; its close above the box high or below its low DECIDES it, before any extension, so
 *  a breakout candle that would still fit under the limit is not swallowed; otherwise its high and low extend the box
 *  where the height limit allows (a wick past the limit is counted, never a box bound). */
export function scanBoxes(candles: readonly Candle[], supportsAt: (asOf: number) => Support[], atr: number, config: BoxConfig): BoxRecord[] {
  const limit = config.maxBoxHeightAtr * atr, minCandles = Math.ceil(config.minBoxMinutes / config.candleMinutes), out: BoxRecord[] = [];
  let floor = 0, pending: number | null = null;
  let live: { from: number; to: number; high: number; low: number; wicks: number; support: unknown; formedAt: number; atFormation: Record<string, unknown> } | null = null;
  const boxOf = (l: NonNullable<typeof live>) => ({ start: iso(candles[l.from]!.start), end: iso(candles[l.to]!.end), high: shown(l.high), low: shown(l.low),
    height: shown(l.high - l.low), heightToAtr: ratio((l.high - l.low) / atr), candles: l.to - l.from + 1, wickOutsideCandles: l.wicks });
  const finish = (l: NonNullable<typeof live>, status: BoxRecord["status"], extra: Partial<BoxRecord>) => {
    const inside = candles.slice(l.from, l.to + 1), before = candles.slice(Math.max(0, l.from - config.contractionLookbackCandles), l.from);
    out.push({ status, box: boxOf(l), support: l.support, formedAt: iso(l.formedAt), contractionAtFormation: l.atFormation,
      contraction: { ...contraction(inside, before, config).evidence }, decision: null, voided: null, entries: null, ...extra });
  };
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    if (live) {
      if (c.close === null) { finish(live, "voided", { voided: { reason: "candle_unobserved", candleStart: iso(c.start) } }); live = null; floor = i + 1; pending = null; continue; }
      if (c.close > live.high || c.close < live.low) {
        const up = c.close > live.high, stop = live.low, boxHeight = live.high - live.low;
        finish(live, "decided", { decision: { direction: up ? "up" : "down", candleStart: iso(c.start), candleEnd: iso(c.end), close: shown(c.close) },
          entries: up ? { A: sizedEntry(live.low + config.entryAFractionOfBox * boxHeight, stop, config), B: sizedEntry(c.close, stop, config), stop: shown(stop) } : null });
        live = null; floor = i + 1; pending = null; continue;
      }
      // Each side extends on its own while the box stays within the limit; a side that would break it is a wick, counted only.
      const high = Math.max(live.high, c.high), low = Math.min(live.low, c.low);
      let wick = false;
      if (high > live.high) { if (high - live.low <= limit) live.high = high; else wick = true; }
      if (low < live.low) { if (live.high - low <= limit) live.low = low; else wick = true; }
      if (wick) live.wicks++;
      live.to = i; continue;
    }
    if (c.close === null) { floor = i + 1; pending = null; continue; }
    if (pending !== null && height(candles.slice(pending, i + 1)) > limit) pending = null;
    if (pending === null && i - minCandles + 1 >= floor && height(candles.slice(i - minCandles + 1, i + 1)) <= limit) pending = i - minCandles + 1;
    if (pending === null || i - pending + 1 < minCandles) continue;
    // A candle that closes beyond the run before it is that run's breakout, not part of its formation.
    const run = candles.slice(pending, i);
    if (run.length && (c.close! > Math.max(...run.map(x => x.high)) || c.close! < Math.min(...run.map(x => x.low)))) { pending = null; floor = i + 1; continue; }
    const inside = candles.slice(pending, i + 1), low = Math.min(...inside.map(x => x.low)), high = Math.max(...inside.map(x => x.high));
    const squeeze = contraction(inside, candles.slice(Math.max(0, pending - config.contractionLookbackCandles), pending), config);
    const at = supportUnderBox(low, supportsAt(c.end), atr, config);
    if (squeeze.fired && at.fired) live = { from: pending, to: i, high, low, wicks: 0, support: at.evidence.support, formedAt: c.end,
      atFormation: { ...squeeze.evidence } };
  }
  if (live) finish(live, "live", {});
  return out;
}
