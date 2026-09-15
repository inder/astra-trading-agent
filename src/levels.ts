// Support and resistance from daily bars: zones, open gaps and trend lines, per timeframe. Deterministic, no model.
// A port of the prototype the founder validated by eye (astra-levels-prototype/levels.py, commit e5d2e6f), rule for
// rule, with the differences listed in DIVERGENCES below. Geometry is by bar index, as on the charts: a halted or
// missing session is invisible to it. Numbers are full precision here; rounding belongs to whatever displays them.
import { timestamp } from "./validation.ts";

/** Daily bars, oldest first, as columns: the shape the prototype and its fixtures use. */
export interface DailyBars { time: string[]; open: number[]; high: number[]; low: number[]; close: number[] }
export interface ZoneMember { date: string; price: number; kind: "high" | "low" | "broken support" | "broken resistance" }
export interface Zone { id: string; lo: number; hi: number; tests: number; last: string; members: ZoneMember[] }
export interface Gap { side: "resistance" | "support"; from: string; lo: number; hi: number }
export interface TrendTouch { time: string; value: number; recent: boolean }
export interface TrendLine { from: string; to: string; fromValue: number; toValue: number; nextValue: number;
  touches: TrendTouch[]; confirmed: boolean; slopePerBar: number }
export interface Analysis {
  atr: number; atrPct: number; width: number; resistance: Zone[]; support: Zone[]; gaps: Gap[];
  trend: { resistance: TrendLine | null; support: TrendLine | null; resistanceNear: TrendLine | null; supportNear: TrendLine | null };
}
export interface Frame extends Partial<Analysis> {
  label: string; timeframe: Timeframe; start: string; sessions: number;
  /** The history starts well after the window did: a stock listed inside it, so this is not a full window. */
  sinceListing: boolean;
  /** Why there are no levels for this timeframe, when there are none. */
  unavailable?: string;
}
export type Timeframe = "qtd" | "ytd" | "2y";
export interface Levels {
  asOf: string; price: number; priceSource: "quote" | "close"; sessions: number;
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
  "Trend lines that rank equally are separated by the earlier anchor, then the shallower slope, instead of by the order they were found in.",
] as const;

export const LEVELS_SETTINGS = {
  swingBars: { default: 2, min: 1, max: 10 },
  atrBars: { default: 14, min: 2, max: 100 },
  zoneWidthAtr: { default: 0.5, min: 0.05, max: 3 },
  testReachZone: { default: 0.5, min: 0, max: 2 },
  recentBars: { default: 3, min: 0, max: 20 },
  maxZonesPerSide: { default: 10, min: 1, max: 50 },
  trendToleranceAtr: { default: 0.2, min: 0.01, max: 2 },
  trendMinBars: { default: 5, min: 2, max: 100 },
  trendConfirmTouches: { default: 3, min: 2, max: 10 },
  trendMaxDistanceAtr: { default: 10, min: 1, max: 50 },
  trendWickAtr: { default: 1.5, min: 0, max: 5 },
  listingSlackDays: { default: 7, min: 0, max: 60 },
  minSessions: { default: 20, min: 5, max: 250 },
} as const;
export interface LevelsSettings {
  swingBars: number; atrBars: number; zoneWidthAtr: number; testReachZone: number; recentBars: number;
  maxZonesPerSide: number; trendToleranceAtr: number; trendMinBars: number; trendConfirmTouches: number;
  trendMaxDistanceAtr: number; trendWickAtr: number; listingSlackDays: number; minSessions: number;
  movingAverages: number[]; timeframes: Timeframe[];
}
export const MOVING_AVERAGES = [10, 21, 50, 200];
export const TIMEFRAMES: Timeframe[] = ["qtd", "ytd", "2y"];
const LABELS: Record<Timeframe, string> = { qtd: "QTD", ytd: "YTD", "2y": "2 years" };
const whole = (v: unknown, r: { min: number; max: number }) => typeof v === "number" && Number.isSafeInteger(v) && v >= r.min && v <= r.max;
const real = (v: unknown, r: { min: number; max: number }) => typeof v === "number" && Number.isFinite(v) && v >= r.min && v <= r.max;
const INTEGER_SETTINGS = ["swingBars", "atrBars", "recentBars", "maxZonesPerSide", "trendMinBars", "trendConfirmTouches", "listingSlackDays", "minSessions"] as const;
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
  out.timeframes = raw.timeframes ?? TIMEFRAMES;
  if (!Array.isArray(out.movingAverages) || out.movingAverages.length > 8 ||
    out.movingAverages.some(m => !whole(m, { min: 2, max: 500 })) || new Set(out.movingAverages).size !== out.movingAverages.length)
    throw new Error("Invalid levels setting: movingAverages");
  if (!Array.isArray(out.timeframes) || !out.timeframes.length || out.timeframes.some(t => !TIMEFRAMES.includes(t)) ||
    new Set(out.timeframes).size !== out.timeframes.length) throw new Error("Invalid levels setting: timeframes");
  if (out.trendMinBars <= out.swingBars) throw new Error("Invalid levels setting: trendMinBars");
  return out;
}

const isDate = (s: unknown) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(timestamp(`${s}T00:00:00Z`));
/** The window's first date for a timeframe, from the last bar's date. */
export function windowStart(last: string, timeframe: Timeframe): string {
  const year = Number(last.slice(0, 4)), month = Number(last.slice(5, 7));
  if (timeframe === "qtd") return `${year}-${String(3 * Math.floor((month - 1) / 3) + 1).padStart(2, "0")}-01`;
  if (timeframe === "ytd") return `${year}-01-01`;
  return `${year - 2}${last.slice(4)}`;
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
  const atr = tr.slice(-settings.atrBars).reduce((a, b) => a + b, 0) / settings.atrBars;
  if (!(atr > 0)) return { unavailable: "no price movement in this window" };
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
        .map(x => ({ date: t[x.index]!, price: x.level, kind: x.kind }));
      return { id: `${resistance ? "R" : "S"}${index + 1}`, lo: z.lo, hi: z.hi, tests, last: members[0]!.date, members };
    });
  };

  // Open gaps: a range a bar skipped that price never traded back through. Above the price a drop left it
  // (resistance); below the price a jump left it (support).
  const gaps: Gap[] = [];
  for (let i = lead + 1; i < n; i++) {
    if (h[i]! < l[i - 1]! && !h.slice(i + 1).some(x => x >= l[i - 1]!) && l[i - 1]! > price)
      gaps.push({ side: "resistance", from: t[i]!, lo: Math.max(...h.slice(i)), hi: l[i - 1]! });
    if (l[i]! > h[i - 1]! && !l.slice(i + 1).some(x => x <= h[i - 1]!) && h[i - 1]! < price)
      gaps.push({ side: "support", from: t[i]!, lo: h[i - 1]!, hi: Math.min(...l.slice(i)) });
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
  return { atr, atrPct: atr / price * 100, width, resistance: zoneSide(true), support: zoneSide(false), gaps,
    trend: { resistance: resistanceLine, support: supportLine, resistanceNear, supportNear } };
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
export function levels(daily: DailyBars, settings: LevelsSettings = parseLevelsSettings(), quote?: number): Levels {
  const empty: Levels = { asOf: "", price: 0, priceSource: "close", sessions: 0, averages: [], frames: [], defaultTimeframe: null, warnings: [] };
  const problem = unusable(daily, settings);
  const t = daily?.time ?? [], n = t.length;
  if (problem) return { ...empty, asOf: t[n - 1] ?? "", sessions: n, warnings: [problem],
    frames: settings.timeframes.map(timeframe => ({ label: LABELS[timeframe], timeframe, start: "", sessions: n, sinceListing: false, unavailable: problem })) };
  const price = quote ?? daily.close[n - 1]!;
  const averages = settings.movingAverages.map(period => ({ period,
    value: n >= period ? daily.close.slice(n - period).reduce((a, b) => a + b, 0) / period : null }));
  const frames: Frame[] = settings.timeframes.map(timeframe => {
    const start = windowStart(t[n - 1]!, timeframe);
    const from = t.findIndex(x => x >= start);
    const lead = Math.min(Math.max(from, 0), settings.swingBars);
    const first = from < 0 ? n : from;
    const sessions = n - first;
    // History that starts well after the window did: the stock listed inside this window, so it is not a full one.
    const sinceListing = days(start, t[0]!) > settings.listingSlackDays;
    const base: Frame = { label: LABELS[timeframe], timeframe, start: t[first] ?? start, sessions, sinceListing };
    if (sessions < settings.minSessions) return { ...base, unavailable: `only ${sessions} sessions in this window; needs ${settings.minSessions}` };
    const window: DailyBars = { time: t.slice(first - lead), open: daily.open.slice(first - lead), high: daily.high.slice(first - lead),
      low: daily.low.slice(first - lead), close: daily.close.slice(first - lead) };
    const analysis = analyzeWindow(window, settings, lead, quote);
    return "unavailable" in analysis ? { ...base, ...analysis } : { ...base, ...analysis };
  });
  // The longest timeframe that has levels, so early in January a portfolio still shows the 2-year picture.
  const usable = frames.filter(f => !f.unavailable);
  const longest = TIMEFRAMES.filter(tf => usable.some(f => f.timeframe === tf)).at(-1) ?? null;
  return { asOf: t[n - 1]!, price, priceSource: quote === undefined ? "close" : "quote", sessions: n, averages, frames,
    defaultTimeframe: longest, warnings: splitWarnings(daily) };
}
