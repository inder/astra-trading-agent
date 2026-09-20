// Support and resistance from daily bars: zones, open gaps and trend lines, per timeframe. Deterministic, no model.
// A port of the prototype the founder validated by eye (astra-levels-prototype/levels.py, commit e5d2e6f), rule for
// rule, with the differences listed in DIVERGENCES below. Geometry is by bar index, as on the charts: a halted or
// missing session is invisible to it. Numbers are full precision here; rounding belongs to whatever displays them.
import { timestamp } from "./validation.ts";

/** Daily bars, oldest first, as columns: the shape the prototype and its fixtures use. */
export interface DailyBars { time: string[]; open: number[]; high: number[]; low: number[]; close: number[] }
export interface ZoneMember { date: string; price: number; kind: "high" | "low" | "broken support" | "broken resistance";
  /** This member is the price's own recent footprint — one of the last `recentBars` bars' extremes — rather than a
   *  swing pivot. It matters because on the day a stock makes a new high, that session's own high becomes a
   *  resistance candidate a few cents overhead, so a zone built only from such members is not prior structure and
   *  must not count as something standing above the price. */
  fromRecentBar?: true }

/** A zone the price closed through, by a margin, for long enough to mean it.
 *
 *  Distinct from `ZoneMember.kind`'s `"broken resistance"`, which says only *a former swing high now sits below the
 *  price* — true of a high the stock drifted past years ago, and carrying no claim that anything was observed
 *  breaking. A zone can carry that kind with no `broke` at all. */
export interface ZoneBreak {
  /** Which way the price went through it. */
  direction: "above" | "below";
  /** The settled session whose close first went through. */
  on: string;
  /** Consecutive settled closes beyond it, counting from `on`. */
  closes: number;
  /** Frame bars from `on` to the last settled bar. Bars of the frame's own kind: weeks on the five-year chart. */
  barsSince: number;
  /** `barsSince <= breakRecentBars`. A setting, not a filter baked into the data — an older break keeps its date
   *  and is simply not recent, so `get_levels` stays complete and the threshold stays adjustable. */
  recent: boolean;
  /** How often this zone turned the price away BEFORE the break, under the side's rule it had then.
   *
   *  Not `Zone.tests`, and the difference is the easiest wrong number in this feature: after a flip, `tests` is
   *  recomputed under the OTHER side's rule across the whole window, so the years a level spent acting as a
   *  ceiling get counted as it having "held" as support. */
  testsBefore: number;
  /** A later settled close came back inside: the break was given back, on this session. */
  backInsideOn?: string;
}
export interface Zone { id: string; lo: number; hi: number; tests: number; last: string; members: ZoneMember[];
  /** Named `broke`, not `break`: the latter is a reserved word, so `const { break } = zone` is a syntax error and
   *  every consumer would have to rename it at the boundary. Cheap now, a wire break later. */
  broke?: ZoneBreak }
export interface Gap { side: "resistance" | "support"; from: string; lo: number; hi: number; filling?: true }
export interface TrendTouch { time: string; value: number; recent: boolean }
export interface TrendLine { from: string; to: string; fromValue: number; toValue: number; nextValue: number;
  touches: TrendTouch[]; confirmed: boolean; slopePerBar: number }
export interface Analysis {
  atr: number; atrPct: number; width: number; resistance: Zone[]; support: Zone[]; gaps: Gap[];
  trend: { resistance: TrendLine | null; support: TrendLine | null; resistanceNear: TrendLine | null; supportNear: TrendLine | null };
  /** What stands above the price in this window, so "nothing above it" can be stated as a fact rather than shown as
   *  an em-dash — which is the character this report uses for *unknown*, and a stock at the top of its range is not
   *  unknown.
   *
   *  `zones` excludes any zone built only from the last `recentBars` bars' highs: on a breakout day the session's
   *  own high becomes a candidate just overhead, so counting it would mean the check never fires for precisely the
   *  stock it exists for.
   *
   *  Unlike a break, this follows the displayed price, including a live quote — it describes the zones as shown,
   *  in the present tense. A break is a past-tense claim about a settled session and deliberately does not move
   *  intraday; whatever states this must keep that distinction in its words. */
  overhead: { zones: number; gaps: number; line: boolean };
}
export interface Frame extends Partial<Analysis> {
  label: string; timeframe: Timeframe; start: string; sessions: number;
  /** Which bars this frame measured. On a weekly frame every quantity is weekly: `sessions` counts weeks, and the
   *  ATR, zone width and trend tolerance are a week's movement, not a day's. */
  bar: "day" | "week";
  /** The history starts well after the window did: a stock listed inside it, so this is not a full window. */
  sinceListing: boolean;
  /** Why there are no levels for this timeframe, when there are none. */
  unavailable?: string;
}
export type Timeframe = "qtd" | "ytd" | "2y" | "5y";
export interface Levels {
  /** The last settled session these levels were measured from. Zones never come from a later trade. */
  asOf: string;
  price: number;
  /** Where `price` came from. `close` is `asOf`'s official close. The rest are trades later than that close: `quote`
   *  during the session, and `after-hours` or `pre-market` outside it — which is how a price can be newer than the
   *  last close the provider has published. A reader must be told which, so a report can never imply a price is a
   *  closing price when it is not. */
  priceSource: "close" | "quote" | "after-hours" | "pre-market";
  /** When the trade behind `price` happened, when it was not a close. */
  priceAt: string | null;
  sessions: number;
  averages: { period: number; value: number | null }[];
  frames: Frame[]; defaultTimeframe: Timeframe | null;
  /** Data problems worth saying out loud rather than silently computing through. */
  warnings: string[];
}
/** Knowingly different from the prototype, per the 2026-09-15 design review. */
export const DIVERGENCES = [
  "No pattern detection (cup with handle, flat base, tightening): the prototype's patterns.py is not ported yet.",
  "sinceListing is reported for every timeframe, not only 2 years, so a recent listing's YTD is never read as a full year.",
  "Thin or unusable history returns a reason instead of throwing, and an ATR of zero is unusable.",
  "Values are full precision; the prototype rounded inside the engine.",
  "Moving averages default to 10, 21, 50 and 200 (the founder's charts), not 20, 50 and 200.",
  "Breaks have no counterpart in the prototype: a zone the price closed through by a margin for enough settled sessions carries `broke`, with the session it went on and how often it had held before. The margin is sized from a WINDOW-mean ATR rather than the trailing one every other tolerance here uses, so a break's date cannot move with this week's volatility.",
  "Trend lines that rank equally are separated by the earlier anchor, then the shallower slope, instead of by the order they were found in.",
  "The weekly timeframe has no counterpart in the prototype and so no parity fixture: it is the same rules over folded bars, checked by its own assertions.",
] as const;

export const LEVELS_SETTINGS = {
  swingBars: { default: 2, min: 1, max: 10 },
  atrBars: { default: 14, min: 2, max: 100 },
  zoneWidthAtr: { default: 0.5, min: 0.05, max: 3 },
  testReachZone: { default: 0.5, min: 0, max: 2 },
  recentBars: { default: 3, min: 0, max: 20 },
  /** How far beyond a zone's edge a close must finish to count as through it, in ATR. A close a cent past the edge
   *  is not a break of anything, and a percentage would mean something different on a $6 stock and a $600 one —
   *  ATR is the unit every other tolerance here already uses. A quarter of one is half a default zone width. */
  breakCloseAtr: { default: 0.25, min: 0, max: 3 },
  /** Consecutive settled closes beyond the edge before the page will call it a break. Two by default: the page
   *  makes a claim in words, and a one-day print that reverses turns that claim into a retraction on the next run.
   *  One session of lateness buys the claim. Set to 1 for the more intuitive reading. */
  breakConfirmBars: { default: 2, min: 1, max: 10 },
  /** How long a break stays worth saying, in the frame's own bars — so thirty is thirty WEEKS on the five-year
   *  chart, which has a correspondingly longer memory. Older breaks keep their date and are simply not recent. */
  breakRecentBars: { default: 30, min: 1, max: 500 },
  /** How often a zone must have turned the price away BEFORE the price closed through it, or there was nothing
   *  there to break.
   *
   *  Measured, not assumed. A steadily climbing stock passes minor levels constantly, and without this every one of
   *  them reports a break: a 50-bar climb produced two, each with `testsBefore` of exactly 1 — the single bar that
   *  happened to sit under the level on the way past. The range the founder described INTC being "stuck in" scored
   *  **20** on the same measure, and the incidental levels around it scored 0. One rejection is a bar; two is a
   *  level that acted. Set to 0 to report every crossing. */
  breakMinTests: { default: 2, min: 0, max: 50 },
  maxZonesPerSide: { default: 10, min: 1, max: 50 },
  trendToleranceAtr: { default: 0.2, min: 0.01, max: 2 },
  trendMinBars: { default: 5, min: 2, max: 100 },
  trendConfirmTouches: { default: 3, min: 2, max: 10 },
  trendMaxDistanceAtr: { default: 10, min: 1, max: 50 },
  trendWickAtr: { default: 1.5, min: 0, max: 5 },
  listingSlackDays: { default: 7, min: 0, max: 60 },
  minSessions: { default: 20, min: 5, max: 250 },
  /** How far back the weekly frame looks, and the fewest weeks it will draw levels from. */
  weeklyYears: { default: 5, min: 1, max: 20 },
  weeklyMinSessions: { default: 30, min: 5, max: 250 },
  /** The weekly frame's own trend-line rules. A week's ATR is several times a day's, so the daily allowances are far
   *  too generous over weekly bars: at 10 ATR a five-year line can sit 80% below the price and still be "near" it,
   *  and five bars is a five-week anchor for a five-year line. Found on a real DELL chart, 2026-09-15.
   *
   *  The distance default was swept against real HPE and DELL history: 3 and 4 behave identically on both, and 5 is
   *  a cliff — it starts admitting lines 61% to 85% below the price. 3 keeps the margin. A stock that has run too far
   *  for any line to be near, as DELL had, correctly gets no weekly line rather than a meaningless one. */
  weeklyTrendMaxDistanceAtr: { default: 3, min: 0.5, max: 50 },
  weeklyTrendMinBars: { default: 12, min: 2, max: 100 },
} as const;
export interface LevelsSettings {
  swingBars: number; atrBars: number; zoneWidthAtr: number; testReachZone: number; recentBars: number;
  breakCloseAtr: number; breakConfirmBars: number; breakRecentBars: number; breakMinTests: number;
  maxZonesPerSide: number; trendToleranceAtr: number; trendMinBars: number; trendConfirmTouches: number;
  trendMaxDistanceAtr: number; trendWickAtr: number; listingSlackDays: number; minSessions: number;
  weeklyYears: number; weeklyMinSessions: number;
  weeklyTrendMaxDistanceAtr: number; weeklyTrendMinBars: number;
  movingAverages: number[]; timeframes: Timeframe[];
}
export const MOVING_AVERAGES = [10, 21, 50, 200];
/** Weekly frames measure weekly bars; everything else measures daily ones. */
export const WEEKLY_TIMEFRAMES: Timeframe[] = ["5y"];
export const DAILY_TIMEFRAMES: Timeframe[] = ["qtd", "ytd", "2y"];
export const TIMEFRAMES: Timeframe[] = [...DAILY_TIMEFRAMES, ...WEEKLY_TIMEFRAMES];
const weekly = (timeframe: Timeframe) => WEEKLY_TIMEFRAMES.includes(timeframe);
const LABELS: Record<Timeframe, string> = { qtd: "QTD", ytd: "YTD", "2y": "2 years", "5y": "5 years (weekly)" };
const whole = (v: unknown, r: { min: number; max: number }) => typeof v === "number" && Number.isSafeInteger(v) && v >= r.min && v <= r.max;
const real = (v: unknown, r: { min: number; max: number }) => typeof v === "number" && Number.isFinite(v) && v >= r.min && v <= r.max;
const INTEGER_SETTINGS = ["swingBars", "atrBars", "recentBars", "breakConfirmBars", "breakRecentBars", "breakMinTests", "maxZonesPerSide", "trendMinBars", "trendConfirmTouches",
  "listingSlackDays", "minSessions", "weeklyYears", "weeklyMinSessions", "weeklyTrendMinBars"] as const;
/** Every rule is a setting with the founder's default (constants are configuration); anything out of range is refused. */
export function parseLevelsSettings(raw: Partial<LevelsSettings> = {}): LevelsSettings {
  const keys = [...Object.keys(LEVELS_SETTINGS), "movingAverages", "timeframes"];
  if (Object.keys(raw).some(k => !keys.includes(k))) throw new Error("Unknown levels setting");
  const out = Object.fromEntries(Object.entries(LEVELS_SETTINGS).map(([k, r]) => {
    const given = (raw as Record<string, unknown>)[k];
    const value = given === undefined ? r.default : given;
    const ok = (INTEGER_SETTINGS as readonly string[]).includes(k) ? whole(value, r) : real(value, r);
    if (!ok) throw new Error(`Invalid levels setting: ${k}`);
    return [k, value];
  })) as unknown as LevelsSettings;
  out.movingAverages = raw.movingAverages ?? MOVING_AVERAGES;
  // Daily by default: the weekly frame answers a different question, and a written reply should not grow a fourth
  // window nobody asked for. A caller that wants it — the chart — asks for it.
  out.timeframes = raw.timeframes ?? DAILY_TIMEFRAMES;
  if (!Array.isArray(out.movingAverages) || out.movingAverages.length > 8 ||
    out.movingAverages.some(m => !whole(m, { min: 2, max: 500 })) || new Set(out.movingAverages).size !== out.movingAverages.length)
    throw new Error("Invalid levels setting: movingAverages");
  if (!Array.isArray(out.timeframes) || !out.timeframes.length || out.timeframes.some(t => !TIMEFRAMES.includes(t)) ||
    new Set(out.timeframes).size !== out.timeframes.length) throw new Error("Invalid levels setting: timeframes");
  if (out.trendMinBars <= out.swingBars) throw new Error("Invalid levels setting: trendMinBars");
  // A window must be long enough to average the ATR over, or its zones are sized by a handful of bars. The weekly
  // frame counts weeks, so it needs the same check against its own minimum.
  if (out.atrBars > out.minSessions || out.atrBars > out.weeklyMinSessions) throw new Error("Invalid levels setting: atrBars");
  if (out.weeklyTrendMinBars <= out.swingBars) throw new Error("Invalid levels setting: weeklyTrendMinBars");
  return out;
}

const isDate = (s: unknown) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(timestamp(`${s}T00:00:00Z`));
/** The window's first date for a timeframe, from the last bar's date. */
/** Every timeframe is named here on purpose: a fallthrough would silently hand a new timeframe someone else's window
 *  and label it with its own name. */
export function windowStart(last: string, timeframe: Timeframe, settings?: LevelsSettings): string {
  const year = Number(last.slice(0, 4)), month = Number(last.slice(5, 7));
  if (timeframe === "qtd") return `${year}-${String(3 * Math.floor((month - 1) / 3) + 1).padStart(2, "0")}-01`;
  if (timeframe === "ytd") return `${year}-01-01`;
  if (timeframe === "2y") return `${year - 2}${last.slice(4)}`;
  if (timeframe === "5y") return `${year - (settings?.weeklyYears ?? LEVELS_SETTINGS.weeklyYears.default)}${last.slice(4)}`;
  throw new Error(`Unknown timeframe: ${timeframe}`);
}
/** The Monday of a session's week, from the date string alone. */
const mondayOf = (date: string) => {
  const ms = Date.parse(`${date}T00:00:00Z`);
  return new Date(ms - ((new Date(ms).getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10);
};
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
/** Daily bars folded into weeks: the week's open is Monday's open, its high and low the week's extremes, its close the
 *  last session's. A week is dated by its Monday.
 *
 *  The trailing week is dropped until it is over — the same rule the daily reader applies to the session still
 *  trading, for the same reason: a week in progress has a provisional high, low and close, and a provisional bar must
 *  never become a level. "Over" means its Friday has settled, or the settled date has moved into a later week (so a
 *  week whose Friday was a holiday is counted from the following Monday rather than left out forever). */
export function aggregateWeekly(bars: DailyBars, settledThrough = bars.time.at(-1) ?? ""): DailyBars {
  const out: DailyBars = { time: [], open: [], high: [], low: [], close: [] };
  for (let i = 0; i < bars.time.length; i++) {
    const week = mondayOf(bars.time[i]!);
    if (out.time.at(-1) === week) {
      out.high[out.high.length - 1] = Math.max(out.high.at(-1)!, bars.high[i]!);
      out.low[out.low.length - 1] = Math.min(out.low.at(-1)!, bars.low[i]!);
      out.close[out.close.length - 1] = bars.close[i]!;
    } else {
      out.time.push(week); out.open.push(bars.open[i]!); out.high.push(bars.high[i]!);
      out.low.push(bars.low[i]!); out.close.push(bars.close[i]!);
    }
  }
  const last = out.time.at(-1);
  if (last && settledThrough && settledThrough < addDays(last, 4) && mondayOf(settledThrough) === last) {
    for (const key of ["time", "open", "high", "low", "close"] as const) out[key].pop();
  }
  return out;
}
/** A moving average as a series, for drawing. `levels()` reports only each average's latest value, which is all a
 *  written answer needs; a chart needs the line, and it must come from here rather than be recomputed by whatever
 *  draws it. Points begin where the average has enough bars behind it.
 *
 *  `periods` defaults to the constant, NOT to a settings object: a caller working from configured settings must pass
 *  `settings.movingAverages`, or its chart will draw lines the written answer never mentions. The running sum here
 *  and the slice sum in `levels()` can differ in the last decimals over a long history; compare with a tolerance. */
export function movingAverageSeries(bars: DailyBars, periods: number[] = MOVING_AVERAGES) {
  return periods.map(period => {
    const points: { time: string; value: number }[] = [];
    let sum = 0;
    for (let i = 0; i < bars.close.length; i++) {
      sum += bars.close[i]!;
      if (i >= period) sum -= bars.close[i - period]!;
      if (i >= period - 1) points.push({ time: bars.time[i]!, value: sum / period });
    }
    return { period, points };
  });
}
const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

/** Zones, gaps and trend lines for one window. `lead` bars precede the window: they only let a swing point on the
 *  window's first days see its neighbours (Jul 2 was HPE's second QTD bar and was missed without them). */
export function analyzeWindow(bars: DailyBars, settings: LevelsSettings, lead = 0, quote?: number): Analysis | { unavailable: string } {
  const { time: t, high: h, low: l, close: c } = bars, n = t.length;
  const price = quote ?? c[n - 1]!;
  if (!(price > 0)) return { unavailable: "no usable price" };
  const tr = [h[0]! - l[0]!, ...Array.from({ length: n - 1 }, (_, x) => {
    const i = x + 1; return Math.max(h[i]! - l[i]!, Math.abs(h[i]! - c[i - 1]!), Math.abs(l[i]! - c[i - 1]!));
  })];
  // Averaged over the true ranges there actually are: dividing by the setting when the window is shorter would
  // deflate the ATR, and every zone width and trend tolerance downstream with it.
  const recentRanges = tr.slice(-settings.atrBars);
  const atr = recentRanges.reduce((a, b) => a + b, 0) / recentRanges.length;
  if (!(atr > 0)) return { unavailable: "no price movement in this window" };
  // A SECOND ATR, over the whole window, and it exists for one reason: `atr` above is trailing — the last
  // `atrBars` true ranges — so it moves with this week's volatility. Sizing the break margin from it would let a
  // claim about a September session be re-adjudicated by today's range: volatility expands after a breakout, the
  // margin widens, the walk-back terminates later, and the page prints a LATER break date next week with no new
  // price action behind it. A date that moves on its own is the plainest possible violation of never stating a
  // number you cannot stand behind. Zone widths and trend tolerances keep the trailing ATR, which is right for
  // them: they describe what the price is doing now.
  const windowRanges = tr.slice(lead);
  const windowAtr = windowRanges.reduce((a, b) => a + b, 0) / windowRanges.length;
  const breakMargin = settings.breakCloseAtr * windowAtr;
  const width = settings.zoneWidthAtr * atr, k = settings.swingBars;
  const pivots = (series: number[], keep: (a: number, b: number) => boolean) => {
    const out: number[] = [];
    for (let i = Math.max(k, lead); i < n - k; i++) {
      let ok = true;
      for (let j = i - k; j <= i + k && ok; j++) if (j !== i && !keep(series[i]!, series[j]!)) ok = false;
      if (ok) out.push(i);
    }
    return out;
  };
  const ph = pivots(h, (a, b) => a >= b), pl = pivots(l, (a, b) => a <= b);
  const recentBars = Array.from({ length: settings.recentBars }, (_, i) => n - settings.recentBars + i).filter(i => i >= 0);

  type Candidate = { level: number; index: number; kind: ZoneMember["kind"] };
  const zoneSide = (resistance: boolean): Zone[] => {
    const raw: Candidate[] = resistance
      ? [...ph.map(i => ({ level: h[i]!, index: i, kind: "high" as const })), ...pl.map(i => ({ level: l[i]!, index: i, kind: "broken support" as const })),
         ...recentBars.map(i => ({ level: h[i]!, index: i, kind: "high" as const }))].filter(x => x.level > price)
      : [...pl.map(i => ({ level: l[i]!, index: i, kind: "low" as const })), ...ph.map(i => ({ level: h[i]!, index: i, kind: "broken resistance" as const })),
         ...recentBars.map(i => ({ level: l[i]!, index: i, kind: "low" as const }))].filter(x => x.level < price);
    // Nearest the price first, ties by bar then kind, so grouping and ids are the same on every run.
    const order = (a: Candidate, b: Candidate) => (resistance ? a.level - b.level : b.level - a.level) || a.index - b.index || a.kind.localeCompare(b.kind);
    const candidates = [...raw].sort(order);
    const grouped: { lo: number; hi: number; at: Candidate[] }[] = [];
    for (const candidate of candidates) {
      const z = grouped[grouped.length - 1];
      const inside = z && (resistance ? candidate.level - z.lo : z.hi - candidate.level) <= width;
      if (z && inside) { z.lo = Math.min(z.lo, candidate.level); z.hi = Math.max(z.hi, candidate.level); z.at.push(candidate); }
      else grouped.push({ lo: candidate.level, hi: candidate.level, at: [candidate] });
    }
    // A bar index belonging to the price's own last few sessions rather than to a swing pivot. Decided by INDEX,
    // not by pivot-set membership: `pivots()` runs to `n - swingBars`, so at the defaults index `n - 3` is BOTH a
    // pivot and one of the last three bars. Asking "is it a pivot?" would answer no-it-is-not-recent for exactly
    // the bar a breakout day produces, and the clear-air check below would never fire for the stock it exists for.
    const isRecentBar = (index: number) => index >= n - settings.recentBars;

    /** Whether the price closed through this zone, by the margin, for long enough to mean it.
     *
     *  Closing through, never trading through: an intraday spike that closes back inside is not a break, and the
     *  rest of this engine already lives by closes — a trend holds on closes, a test requires the close to finish
     *  on the price's side. Counting a high above the zone would make every wick a break and the false-break case
     *  the common one. */
    const brokeThrough = (z: { lo: number; hi: number }, direction: "above" | "below"): ZoneBreak | undefined => {
      // Which way the price went is a fact about the bars, NOT about which side the zone sits on today. A zone
      // above the price may have been broken UPWARD and then closed back into — that is the give-back case, and
      // deriving the direction from the current side would look downward and find nothing, which is how this was
      // written first and what the give-back test caught.
      // Two thresholds, not one, and the gap between them is the point.
      //
      // A break is CONFIRMED by closing clear of the edge by the margin — a close a cent past the edge is not a
      // break of anything. But it is GIVEN BACK only by closing back into the zone itself. Using the margin for
      // both makes the band between the edge and the margin count as "inside", so a price sitting just above a
      // zone it cleared reads as having come back into it: the fixture rendered "back inside since Aug 28" for a
      // price ABOVE the zone, which is how this was caught. Worse, with one threshold a price hovering near the
      // edge would flicker between broken and given-back run to run.
      const beyond = (i: number) => direction === "above" ? c[i]! > z.hi + breakMargin : c[i]! < z.lo - breakMargin;
      const backInside = (i: number) => direction === "above" ? c[i]! <= z.hi : c[i]! >= z.lo;

      // The most recent run of closes beyond the zone, and where it began.
      // The most recent run of closes beyond the zone, and where it began. Bars between the edge and the margin
      // belong to neither state: they do not confirm a break and they do not give one back, so the walk passes
      // over them and the last CONFIRMED close anchors the run.
      let last = n - 1, backInsideOn: string | undefined;
      if (!beyond(last)) {
        while (last >= lead && !beyond(last)) last--;
        if (last < lead) return undefined;                       // never beyond the zone in this window
        // Only a close that actually re-entered the zone gives the break back. A price that cleared the zone and
        // has since drifted within the margin of it has not returned to it.
        const returned = [];
        for (let i = last + 1; i < n; i++) if (backInside(i)) { returned.push(i); break; }
        if (returned.length) backInsideOn = t[returned[0]!]!;
      }
      let first = last;
      while (first > lead && beyond(first - 1)) first--;

      // The price has been beyond this zone for the entire window: nothing was observed breaking. Without this,
      // every old low in a five-year uptrend becomes a fresh breakout. A genuine pre-window break still surfaces
      // on a longer frame, and the default frame is the longest daily one.
      if (first === lead) return undefined;
      // It has to have come from inside or the other side, not merely appeared beyond.
      if (beyond(first - 1)) return undefined;
      const closes = last - first + 1;
      if (closes < settings.breakConfirmBars) return undefined;

      // How often the zone turned the price away BEFORE it went, under the rule the zone had THEN — which is the
      // opposite side's rule, since a zone below the price now was above it then. `Zone.tests` cannot answer this:
      // it is recomputed under the current side's rule across the whole window, so a level's years as a ceiling
      // are counted as it having held as support.
      let testsBefore = 0;
      for (let i = lead; i < first; i++) {
        if (direction === "above") {                              // it was resistance before the break
          if (h[i]! >= z.lo - settings.testReachZone * width && c[i]! < z.hi && l[i]! <= z.hi) testsBefore++;
        } else if (l[i]! <= z.hi + settings.testReachZone * width && c[i]! > z.lo && h[i]! >= z.lo) testsBefore++;
      }
      // Nothing was broken if nothing was holding. Checked AFTER counting, so the threshold stays a setting rather
      // than a rule welded into the walk — and so the count is available to explain why a crossing was not a break.
      if (testsBefore < settings.breakMinTests) return undefined;
      const barsSince = (n - 1) - first;
      return { direction, on: t[first]!, closes, barsSince,
        recent: barsSince <= settings.breakRecentBars, testsBefore,
        ...(backInsideOn ? { backInsideOn } : {}) };
    };

    return grouped.slice(0, settings.maxZonesPerSide).map((z, index) => {
      // A test: the bar reached the zone (or came within reach of it) and closed back on the price's side.
      let tests = 0;
      for (let i = lead; i < n; i++) {
        if (resistance) { if (h[i]! >= z.lo - settings.testReachZone * width && c[i]! < z.hi && l[i]! <= z.hi) tests++; }
        else if (l[i]! <= z.hi + settings.testReachZone * width && c[i]! > z.lo && h[i]! >= z.lo) tests++;
      }
      const seen = new Map<string, Candidate>();
      for (const x of z.at) seen.set(`${x.index}|${x.kind}|${x.level}`, x);   // the prototype grouped members in a set
      const members = [...seen.values()].sort((a, b) => b.index - a.index || b.kind.localeCompare(a.kind) || b.level - a.level)
        // The flag is derived from the surviving member's own index rather than carried on the candidate: a recent
        // bar's high and a pivot high at the same index and level produce byte-identical keys, so which one
        // survives the Map is decided by sort order, and reading the flag off the loser would be arbitrary.
        .map(x => ({ date: t[x.index]!, price: x.level, kind: x.kind, ...(isRecentBar(x.index) ? { fromRecentBar: true as const } : {}) }));
      // Both directions are asked, because neither is implied by the side. When a zone has been broken each way
      // inside one window the later event is the one a reader is looking at.
      const up = brokeThrough(z, "above"), down = brokeThrough(z, "below");
      const broke = !up ? down : !down ? up : up.barsSince <= down.barsSince ? up : down;
      return { id: `${resistance ? "R" : "S"}${index + 1}`, lo: z.lo, hi: z.hi, tests, last: members[0]!.date, members,
        ...(broke ? { broke } : {}) };
    });
  };

  // Open gaps: a range a bar skipped that price never traded back through. Above the price a drop left it
  // (resistance); below the price a jump left it (support).
  const gaps: Gap[] = [];
  // A gap whose range still contains the price is being filled right now; saying so keeps it from reading as a level
  // wholly above or below the stock.
  const gap = (side: Gap["side"], from: string, lo: number, hi: number): Gap =>
    ({ side, from, lo, hi, ...(price > lo && price < hi ? { filling: true as const } : {}) });
  for (let i = lead + 1; i < n; i++) {
    if (h[i]! < l[i - 1]! && !h.slice(i + 1).some(x => x >= l[i - 1]!) && l[i - 1]! > price)
      gaps.push(gap("resistance", t[i]!, Math.max(...h.slice(i)), l[i - 1]!));
    if (l[i]! > h[i - 1]! && !l.slice(i + 1).some(x => x <= h[i - 1]!) && h[i - 1]! < price)
      gaps.push(gap("support", t[i]!, h[i - 1]!, Math.min(...l.slice(i))));
  }

  // Trend lines on bar index. Two confirmed swing points anchor a line, which holds on closes: no close beyond it by
  // more than the tolerance, from its first anchor through the latest bar. An intraday wick may pierce it: a swing
  // point that pierced by up to trendWickAtr and closed back inside counts as a touch (a flush that was bought back).
  // Two lines per side: the strongest (most touches, then the most recent last touch, then the longest span) and the
  // nearest confirmed line to the price when that is a different line.
  const tol = settings.trendToleranceAtr * atr, wick = settings.trendWickAtr * atr;
  const recent = Array.from({ length: k }, (_, i) => n - k + i).filter(i => i >= 0);
  type Found = { rank: [number, number, number]; anchor: number; slope: number; touches: number[] };
  const trend = (pivotList: number[], series: number[], falling: boolean): [TrendLine | null, TrendLine | null] => {
    const found: Found[] = [];
    for (let a = 0; a < pivotList.length; a++) for (let b = a + 1; b < pivotList.length; b++) {
      const i = pivotList[a]!, j = pivotList[b]!;
      if (j - i < settings.trendMinBars) continue;
      const slope = (series[j]! - series[i]!) / (j - i);
      if (falling ? slope >= 0 : slope <= 0) continue;
      const value = (x: number) => series[i]! + slope * (x - i);
      // A flat line far below (or above) the price is intact but no longer a level (INTC's 2025 base at $20).
      if (Math.abs(value(n - 1) - price) > settings.trendMaxDistanceAtr * atr) continue;
      let held = true;
      for (let x = i; x < n && held; x++) held = falling ? c[x]! <= value(x) + tol : c[x]! >= value(x) - tol;
      if (!held) continue;
      const touched = (p: number) => {
        const gap = falling ? series[p]! - value(p) : value(p) - series[p]!;   // above 0: the wick went through the line
        return p >= i && (Math.abs(series[p]! - value(p)) <= tol || (gap > 0 && gap <= wick));
      };
      const touches = [...new Set([...pivotList, ...recent].filter(touched))].sort((x, y) => x - y);
      found.push({ rank: [touches.length, touches[touches.length - 1]!, j - i], anchor: i, slope, touches });
    }
    if (!found.length) return [null, null];
    const line = (e: Found): TrendLine => {
      const value = (x: number) => series[e.anchor]! + e.slope * (x - e.anchor);
      return { from: t[e.anchor]!, to: t[n - 1]!, fromValue: value(e.anchor), toValue: value(n - 1), nextValue: value(n),
        touches: e.touches.map(p => ({ time: t[p]!, value: series[p]!, recent: recent.includes(p) })),
        confirmed: e.touches.length >= settings.trendConfirmTouches, slopePerBar: e.slope };
    };
    // Most touches, then the most recent last touch, then the longest span; equal on all three, the earlier anchor and
    // then the shallower slope decide, so the answer never depends on the order the lines were found in.
    const better = (x: [number, number, number], y: [number, number, number]) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
    const strongest = [...found].sort((a, b) => better(b.rank, a.rank) || a.anchor - b.anchor || a.slope - b.slope)[0]!;
    const confirmed = found.filter(e => e.touches.length >= settings.trendConfirmTouches);
    const today = (e: Found) => series[e.anchor]! + e.slope * (n - 1 - e.anchor);
    // The nearest confirmed line to the price: closest first, then more touches, then the earlier anchor.
    const near: Found | undefined = [...confirmed].sort((a, b) =>
      Math.abs(today(a) - price) - Math.abs(today(b) - price) || b.rank[0] - a.rank[0] || a.anchor - b.anchor)[0];
    const different = near && (near.anchor !== strongest.anchor || near.slope !== strongest.slope);
    return [line(strongest), different ? line(near!) : null];
  };
  const [resistanceLine, resistanceNear] = trend(ph, h, true), [supportLine, supportNear] = trend(pl, l, false);
  const resistanceZones = zoneSide(true), supportZones = zoneSide(false);
  // What stands above the price, so "nothing above it" is a statement rather than an em-dash. A zone built ONLY
  // from the last few bars' highs is the price's own footprint, not prior structure: on the day a stock prints a
  // new high, that session's high is a candidate a few cents overhead, and counting it would mean this never
  // reports clear air for exactly the stock that just made some. A zone with any prior structure in it keeps at
  // least one member that is not from a recent bar, so nothing real is erased.
  const overhead = {
    // `[].every(...)` is true, so a memberless zone would read as "all of it is the price's own footprint" and be
    // dropped from what stands overhead — reporting clear air above a real ceiling. Members are required before
    // anything can be concluded about all of them.
    zones: resistanceZones.filter(z => !(z.members.length > 0 && z.members.every(m => m.fromRecentBar))).length,
    gaps: gaps.filter(g => g.side === "resistance" && !g.filling).length,
    line: !!resistanceLine && resistanceLine.nextValue > price,
  };
  return { atr, atrPct: atr / price * 100, width, resistance: resistanceZones, support: supportZones, gaps,
    trend: { resistance: resistanceLine, support: supportLine, resistanceNear, supportNear }, overhead };
}

/** Bars that cannot support levels at all, named rather than computed through. */
function unusable(bars: DailyBars | undefined, settings: LevelsSettings): string | null {
  if (!bars || !Array.isArray(bars.time) || !bars.time.length) return "no price history";
  const n = bars.time.length;
  for (const key of ["open", "high", "low", "close"] as const) {
    const series = bars[key];
    if (!Array.isArray(series) || series.length !== n) return "price history is incomplete";
    if (series.some(v => !(typeof v === "number" && Number.isFinite(v) && v > 0))) return "price history has invalid prices";
  }
  if (bars.time.some(x => !isDate(x))) return "price history has invalid dates";
  for (let i = 1; i < n; i++) if (bars.time[i]! <= bars.time[i - 1]!) return "price history is out of order";
  if (bars.high.some((x, i) => x < bars.low[i]!)) return "price history has a high below its low";
  // minSessions is the floor on the raw daily history every frame is built from, the weekly fold included, so this
  // gates the whole call rather than one timeframe.
  if (n < settings.minSessions) return `only ${n} sessions of history; needs ${settings.minSessions}`;
  return null;
}
/** A split that the feed did not adjust shows up as a close-to-next-open jump no market makes. */
function splitWarnings(bars: DailyBars): string[] {
  const out: string[] = [];
  for (let i = 1; i < bars.time.length; i++) {
    const ratio = bars.open[i]! / bars.close[i - 1]!;
    if (ratio < 0.55 || ratio > 1.8) out.push(`prices jump ${ratio.toFixed(2)}x between ${bars.time[i - 1]} and ${bars.time[i]}: a split may not be adjusted`);
  }
  return out.slice(0, 3);
}

/** Levels for one stock: every configured timeframe, the moving averages, and which timeframe to show by default.
 *  `quote` is the live price when the caller has one; without it the last close is used, and the result says which. */
/** A trade later than the last settled close, and what kind it was. The caller decides that, because only it knows
 *  the clock and the session; the engine only reports what it was handed. */
export interface LatestTrade { price: number; source: "quote" | "after-hours" | "pre-market"; at: string | null }
export function levels(daily: DailyBars, settings: LevelsSettings = parseLevelsSettings(), quote?: number | LatestTrade,
  settledThrough?: string): Levels {
  const latest: LatestTrade | undefined = typeof quote === "number" ? { price: quote, source: "quote", at: null } : quote;
  const empty: Levels = { asOf: "", price: 0, priceSource: "close", priceAt: null, sessions: 0, averages: [], frames: [], defaultTimeframe: null, warnings: [] };
  const problem = unusable(daily, settings);
  const t = daily?.time ?? [], n = t.length;
  // A price without levels is still a price. Too few sessions to measure a zone says nothing about what the stock
  // last traded at, and leaving it zero here put $0.00 and −100% in a holdings table and made the stock the
  // portfolio's worst performer in what the chat read aloud. Only the levels are unknown; the price is not.
  if (problem) return { ...empty, asOf: t[n - 1] ?? "", sessions: n, warnings: [problem],
    price: latest?.price ?? daily?.close?.[n - 1] ?? 0,
    priceSource: latest?.source ?? "close", priceAt: latest?.at ?? null,
    frames: settings.timeframes.map(timeframe => ({ label: LABELS[timeframe], timeframe, bar: weekly(timeframe) ? "week" : "day",
      start: "", sessions: n, sinceListing: false, unavailable: problem })) };
  const price = latest?.price ?? daily.close[n - 1]!;
  const averages = settings.movingAverages.map(period => ({ period,
    value: n >= period ? daily.close.slice(n - period).reduce((a, b) => a + b, 0) / period : null }));
  // Weekly bars are folded once and shared by every weekly frame, and only when one is asked for.
  // The caller's settled date, not the last bar's, decides whether the trailing week is over: a week whose Friday was
  // a holiday has no Friday bar, and judging it by its own last bar would hide a complete week until Tuesday.
  const weeks = settings.timeframes.some(weekly) ? aggregateWeekly(daily, settledThrough || undefined) : null;
  const frames: Frame[] = settings.timeframes.map(timeframe => {
    const isWeekly = weekly(timeframe);
    const source = isWeekly ? weeks! : daily;
    const bar = isWeekly ? "week" as const : "day" as const;
    const times = source.time, count = times.length;
    const minimum = isWeekly ? settings.weeklyMinSessions : settings.minSessions;
    const unit = isWeekly ? "weeks" : "sessions";
    // The weekly window is measured from the last daily session, so a weekly frame still ends where the price does.
    const start = windowStart(t[n - 1]!, timeframe, settings);
    const from = times.findIndex(x => x >= start);
    const lead = Math.min(Math.max(from, 0), settings.swingBars);
    const first = from < 0 ? count : from;
    const sessions = count - first;
    // History that starts well after the window did: the stock listed inside this window, so it is not a full one.
    const sinceListing = count > 0 && days(start, times[0]!) > settings.listingSlackDays;
    const base: Frame = { label: LABELS[timeframe], timeframe, bar, start: times[first] ?? start, sessions, sinceListing };
    if (sessions < minimum) return { ...base, unavailable: `only ${sessions} ${unit} in this window; needs ${minimum}` };
    const window: DailyBars = { time: times.slice(first - lead), open: source.open.slice(first - lead), high: source.high.slice(first - lead),
      low: source.low.slice(first - lead), close: source.close.slice(first - lead) };
    // The weekly frame swaps in its own trend-line rules. A week's ATR is several times a day's, so the daily
    // allowance would call a line 80% below the price "near" it, and a five-bar anchor is five weeks.
    const rules = isWeekly
      ? { ...settings, trendMaxDistanceAtr: settings.weeklyTrendMaxDistanceAtr, trendMinBars: settings.weeklyTrendMinBars }
      : settings;
    // Every frame is measured against the one price this answer reports. A weekly window's own last close is the
    // last complete week's, so without this a weekly zone could sit on the wrong side of the price shown.
    return { ...base, ...analyzeWindow(window, rules, lead, price) };
  });
  // The longest DAILY timeframe that has levels, so early in January a portfolio still shows the 2-year picture.
  // Weekly is never the default: it answers a different question, and it would otherwise win by being the longest.
  const usable = frames.filter(f => !f.unavailable);
  const longest = DAILY_TIMEFRAMES.filter(tf => usable.some(f => f.timeframe === tf)).at(-1) ?? null;
  return { asOf: t[n - 1]!, price, priceSource: latest?.source ?? "close", priceAt: latest?.at ?? null, sessions: n, averages, frames,
    defaultTimeframe: longest, warnings: splitWarnings(daily) };
}
