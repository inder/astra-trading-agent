#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { TradingAgentService } from "./agent-service.ts";
import { sessionTimes } from "./daily-history.ts";
import { openingRangeConfig, type StrategySettings } from "./orb-config.ts";
import { ReplayMarket, pathPrice, type BarsFile } from "./replay-market.ts";
import type { DailyBars } from "./levels.ts";
import { scanDay, type BoxBar } from "./box-rules.ts";
import { boxConfig, type BoxConfig } from "./box-settings.ts";
import { barCandleCloses, breakoutAbove, setupCancelled } from "./orb-rules.ts";

// Replays one session through Astra's own paper service: REAL minute bars (read from a private fixtures folder, never
// this repository) drive the stock side, and option prices are MODELED. `--check` states which claims each result
// decides and whether they hold; it knows no prices, only the structure the fixtures imply at run time.

export interface ReplayInput {
  date: string; symbols: string[]; regular: BarsFile; volatility: Record<string, number>;
  barLagMs: number; settings: StrategySettings; dataDir: string;
  /** The strategy to run (default: opening-range-options) and, for strategies that read it, each symbol's daily history before the day. */
  strategyId?: string; daily?: Record<string, DailyBars>;
}
export interface ReplayEvent { at: number; type: string; data: any }
export interface ReplayResult {
  events: ReplayEvent[]; halted: string | null; complete: boolean;
  ordersSubmitted: number; pollMs: number; firstTick: number;
}
/** Runs the session tick by tick on a simulated clock, from a minute before the open (catalog prefetch) to the close. */
export async function runReplay(input: ReplayInput): Promise<ReplayResult> {
  const { open, close } = sessionTimes(input.date), pollMs = input.settings.pollMs ?? 1000, firstTick = open - 60000;
  // Claims compare tick times with whole seconds and whole minutes, so ticks must land on both.
  if (pollMs % 1000 || 60000 % pollMs) throw new Error("Replay needs a poll interval of whole seconds that divides a minute");
  let now = firstTick; const clock = () => now;
  const market = new ReplayMarket({ regular: input.regular, clock, volatility: input.volatility, barLagMs: input.barLagMs, ...(input.daily ? { daily: input.daily } : {}) });
  const service = new TradingAgentService(input.dataDir, undefined, undefined, { market, clock, ready: () => true, auto: false });
  const runId = "replay"; let halted: string | null = null;
  try {
    service.paper.configure({ runId, strategyId: input.strategyId ?? "opening-range-options", date: input.date, symbols: input.symbols, includePremarket: false, ...input.settings });
    await service.paper.start(runId);
    for (;;) {
      let status;
      try { status = await service.paper.tick(runId); } catch (error) { halted = String((error as Error).message); break; }
      if (status.status === "completed") break;
      // A run that is still going an hour after the close is a failure to report, not a loop to keep spinning.
      if (now > close + 3600000) { halted = "the run did not complete by the close"; break; }
      now += pollMs;
    }
    const events: ReplayEvent[] = [];
    for (let after = -1; ;) {
      const pages = service.paper.events(runId, after, 100);
      if (!pages.length) break;
      for (const page of pages) { for (const e of page.events) events.push({ at: Date.parse(page.at), type: e.type, data: e.data }); after = page.revision; }
    }
    const final = service.paper.status(runId), stoppedBy = events.findLast(e => e.type === "run_halted")?.data?.detail;
    return { events, halted: halted && stoppedBy ? `${halted}: ${stoppedBy}` : halted, complete: final.status === "completed",
      ordersSubmitted: final.ordersSubmitted, pollMs, firstTick };
  } finally { await service.close(); }
}

/** What the fixtures themselves imply for each stock, by the same rules on the bars: its opening range, the first
 *  second of the modeled path above the high (the path the replay trades on), and the end of the first candle that
 *  closes beneath the cancel level. */
export function openingOutcomes(regular: BarsFile, date: string, settings: StrategySettings = {}) {
  const symbols = regular.data.results.map(r => r.symbol);
  const c = openingRangeConfig({ date, symbols, includePremarketLeadMinutes: 0, ...settings });
  const rangeEnd = sessionTimes(date).open + c.openingRangeMinutes * 60000;
  return Object.fromEntries(regular.data.results.map(r => {
    const bars = [...r.bars].sort((a, b) => Date.parse(a.begins_at) - Date.parse(b.begins_at));
    const first = bars.filter(b => Date.parse(b.begins_at) < rangeEnd), after = bars.filter(b => Date.parse(b.begins_at) >= rangeEnd);
    const range = { high: Math.max(...first.map(b => +b.high_price)), low: Math.min(...first.map(b => +b.low_price)) };
    let firstAbove: number | null = null;
    for (const bar of after) {
      for (let s = 0; s < 60 && firstAbove === null; s++)
        if (breakoutAbove(pathPrice(bar, s), range).fired) firstAbove = Date.parse(bar.begins_at) + s * 1000;
      if (firstAbove !== null) break;
    }
    const candles = barCandleCloses(after.map(b => ({ at: Date.parse(b.begins_at), close: +b.close_price })), rangeEnd, c.candleMinutes);
    const firstCancel = candles.find(k => setupCancelled(k, range, c.openingLowToleranceRanges).fired)?.end ?? null;
    return [r.symbol, { range, firstAbove, firstCancel, candles }];
  }));
}

export interface Claim { id: string; claim: string; modeled: boolean; pass: boolean; detail: string }
/** DONE-ORACLE 1's claims for the article's day, checked structurally: which stock must enter, which must lose its
 *  opening low first, and what the exits must look like. Claims decided by modeled option prices say so. */
export function checkOracle(result: ReplayResult, regular: BarsFile, date: string, settings: StrategySettings,
  expected: { enters: string[]; cancels: string[] }): Claim[] {
  const { open, close } = sessionTimes(date), c = openingRangeConfig({ date, symbols: [...expected.enters, ...expected.cancels], includePremarketLeadMinutes: 0, ...settings });
  const outcomes = openingOutcomes(regular, date, settings), claims: Claim[] = [], rangeEnd = open + c.openingRangeMinutes * 60000;
  const missing = [...expected.enters, ...expected.cancels].filter(s => !outcomes[s]);
  if (missing.length) throw new Error(`The fixtures have no bars for ${missing.join(", ")}`);
  const of = (type: string, symbol?: string) => result.events.filter(e => e.type === type && (!symbol || e.data?.symbol === symbol));
  const add = (id: string, claim: string, modeled: boolean, pass: boolean, detail: string) => claims.push({ id, claim, modeled, pass, detail });
  // Nothing may pass by default: a write-off, a deferred sale, a data gap or a halt would also leave nothing held at the close.
  const unclean = [...of("written_off"), ...of("sale_deferred"), ...of("data_gap"), ...of("candle_unobserved"),
    ...of("setup_disqualified").filter(e => ["observation_gap", "range_unavailable", "late_first_quote"].includes(e.data.reason))];
  add("clean", "the session ran to the close with no write-off, deferred sale, data gap, unobserved candle, halt or data-driven disqualification", false,
    !result.halted && result.complete && result.ordersSubmitted === 0 && !unclean.length,
    result.halted ? `halted: ${result.halted}` : unclean.map(e => e.type + (e.data.reason ? `:${e.data.reason}` : "")).join(", ") || "clean");
  for (const symbol of expected.cancels) {
    const o = outcomes[symbol]!, d = of("setup_disqualified", symbol).find(e => e.data.reason === "opening_low_failed");
    add(`${symbol}-cancel`, `${symbol} closes a candle beneath its cancel level before any breakout and is out for the day within a minute of that close`, false,
      !!d && o.firstCancel !== null && (o.firstAbove === null || o.firstCancel <= o.firstAbove) && d.at >= o.firstCancel && d.at < o.firstCancel + 60000 &&
        !of("paper_entry", symbol).length,
      d ? `cancelled at ${et(d.at)} (candle ending ${o.firstCancel === null ? "never" : et(o.firstCancel)} closed at ${d.data.observedClose} under ${d.data.cancelLevel})` : "not cancelled");
  }
  for (const symbol of expected.enters) {
    const o = outcomes[symbol]!, entries = of("paper_entry", symbol), selection = of("option_selection", symbol)[0];
    const breakTick = o.firstAbove === null ? null : result.firstTick + Math.ceil((o.firstAbove - result.firstTick) / result.pollMs) * result.pollMs;
    const enteredAt = selection ? Date.parse(selection.data.stock.tradeAt) : null;
    add(`${symbol}-entry`, `${symbol} is not cancelled first and buys at the first observed trade above its opening high, before 10:00 ET`, false,
      entries.length === 1 && breakTick !== null && (o.firstCancel === null || o.firstAbove! < o.firstCancel) && enteredAt === breakTick && breakTick < open + 30 * 60000,
      entries.length ? `entered at ${et(enteredAt!)} (first trade above the high at ${o.firstAbove === null ? "never" : et(o.firstAbove)})` : "no entry");
    const entry = entries[0]?.data, n = entry?.quantity ?? 0;
    add(`${symbol}-size`, `${symbol} buys at least ${c.minimumContracts} calls near the money within the per-trade cap`, true,
      !!entry && n >= c.minimumContracts && entry.committedCents <= c.budgetCentsPerPosition && Math.abs(entry.strike / entry.stockPrice - 1) <= 0.05,
      entry ? `${n} x ${entry.strike} calls, committed $${(entry.committedCents / 100).toFixed(2)}` : "no entry");
    const sales = of("paper_sale", symbol), firstTarget = sales.find(s => s.data.reason === "profit_target");
    add(`${symbol}-first-target`, `${symbol} sells half its calls (rounded up) at ${c.firstTargetMultiple}x`, true,
      !!firstTarget && firstTarget.data.targets?.[0] === c.firstTargetMultiple && firstTarget.data.quantity === Math.ceil(n / 2),
      firstTarget ? `${firstTarget.data.quantity} sold at ${et(firstTarget.at)} for ${firstTarget.data.targets.join("x, ")}x` : "no target reached");
    // Every protective stop fires on a candle the bars agree closed beneath the stop level: engine and bars, one rule.
    const stops = of("exit_triggered", symbol).filter(e => e.data.exit === "protective_stop");
    add(`${symbol}-stop`, `${symbol}'s protective stop, if it fired, fired on a candle whose bar close is beneath its stop level`, false,
      stops.every(e => { const k = o.candles.find(k => k.end === Date.parse(e.data.candleEnd)); return !!k && k.close! < e.data.stopLevel; }),
      stops.length ? stops.map(e => `candle ending ${e.data.candleEnd} closed ${e.data.observedClose} under ${e.data.stopLevel}`).join("; ") : "never fired");
    // And the reverse: the first candle after the entry that the bars close under the stop level, while contracts are still
    // held, must be the one the stop fired on. Without this a disabled stop would pass every other claim.
    const entryAt = entries[0]?.at, soldOutAt = (() => { let left = n; for (const s of sales) { left -= s.data.quantity; if (left <= 0) return s.at; } return Infinity; })();
    const due = entry && entryAt !== undefined ? o.candles.find(k => k.end > entryAt && k.close! < entry.stopLevel) : undefined;
    const owed = due && due.end <= soldOutAt ? due : undefined;
    add(`${symbol}-stop-due`, `${symbol}'s protective stop fires on the first candle the bars close under its stop level while it is held`, false,
      !owed || stops.some(e => Date.parse(e.data.candleEnd) === owed.end),
      owed ? `bars close ${owed.close} under ${entry.stopLevel} at ${et(owed.end)}; stop ${stops.length ? `fired on ${stops.map(e => e.data.candleEnd).join(", ")}` : "never fired"}` : "no candle owed a stop");
    const sold = sales.reduce((sum, s) => sum + s.data.quantity, 0), last = sales.at(-1);
    add(`${symbol}-closed`, `${symbol} is fully sold by 3:59 ET by a target, its protective stop or the close-out`, true,
      n > 0 && sold === n && !!last && last.at <= close - c.flattenLeadMinutes * 60000 && ["profit_target", "protective_stop", "session_close"].includes(last.data.reason),
      last ? `${sold} of ${n} sold; last: ${last.data.reason} at ${et(last.at)}` : "nothing sold");
  }
  return claims;
}

const etFormat = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const et = (ms: number) => etFormat.format(ms);
const dollars = (cents: number) => `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;
/** A readable account of the run; every option-derived number is marked MODELED. */
export function timeline(result: ReplayResult): string[] {
  const lines: string[] = [];
  for (const e of result.events) {
    const d = e.data, at = et(e.at);
    if (e.type === "opening_range") lines.push(`${at}  ${d.symbol}  opening range ${d.range.low}-${d.range.high}${d.rangeToAtr != null ? ` (${Math.round(d.rangeToAtr * 100)}% of ATR ${d.atr14})` : ""}`);
    else if (e.type === "setup_disqualified") lines.push(`${at}  ${d.symbol}  out for the day: ${d.reason}${d.observedClose !== undefined
      ? ` (candle ${et(Date.parse(d.candleStart))}-${et(Date.parse(d.candleEnd))} closed ${d.observedClose} under ${d.cancelLevel})` : d.price ? ` (traded ${d.price})` : ""}`);
    else if (e.type === "candle_unobserved") lines.push(`${at}  ${d.symbol}  candle ${et(Date.parse(d.candleStart))}-${et(Date.parse(d.candleEnd))} close not observed; no rule acted`);
    else if (e.type === "entry_skipped") lines.push(`${at}  ${d.symbol}  entry skipped: ${d.reason}`);
    else if (e.type === "entry_aborted") lines.push(`${at}  ${d.symbol}  entry attempt ${d.attempt} of ${d.maxEntryAttempts} stopped: ${d.reason} (quote ${d.price}); watching again`);
    else if (e.type === "paper_entry") lines.push(`${at}  ${d.symbol}  BUY ${d.quantity} x ${d.strike} call exp ${d.expiration} at ${d.assumedFill} MODELED; stock ${d.stockPrice}; committed ${dollars(d.committedCents)}`);
    else if (e.type === "exit_triggered") lines.push(`${at}  ${d.symbol}  ${d.exit} triggered at stock ${d.stockPrice}${d.stopLevel !== undefined ? ` (candle close under ${d.stopLevel})` : ""}`);
    else if (e.type === "paper_sale") lines.push(`${at}  ${d.symbol}  SELL ${d.quantity} (${d.reason}${d.targets ? ` ${d.targets.join("x, ")}x` : ""}) at ${d.assumedFill} MODELED; stock ${d.stockPrice}; P&L ${dollars(d.realizedPnlCents)}`);
    else if (e.type === "written_off") lines.push(`${at}  ${d.symbol}  WRITTEN OFF ${d.quantity}: ${dollars(d.realizedPnlCents)}`);
    else if (e.type === "run_halted") lines.push(`${at}  halted: ${d.detail}`);
    else if (e.type === "universe_checked") lines.push(`${at}  ${d.symbol}  ${d.status === "runaway" ? "runaway" : d.status === "not_runaway" ? "not a runaway" : `unavailable (${d.reason})`}${d.atr14 != null ? ` ATR ${d.atr14}` : ""}`);
    else if (e.type === "supports") lines.push(`${at}  ${d.symbol}  supports before the open: ${d.supports.map((x: any) => `${x.label} ${x.lo === x.hi ? x.lo : `${x.lo}-${x.hi}`}`).join("; ")}${d.vwapAnchorsMissing.length ? ` (no VWAP for ${d.vwapAnchorsMissing.join(", ")})` : ""}`);
    else if (e.type === "box_formed") lines.push(`${at}  ${d.symbol}  BOX formed ${et(Date.parse(d.box.start))}-${et(Date.parse(d.box.end))} ${d.box.low}-${d.box.high} (${d.box.heightToAtr} ATR) on ${d.support?.label}; contraction ${d.contractionAtFormation.ratio}`);
    else if (e.type === "box_decided") lines.push(`${at}  ${d.symbol}  BOX decided ${d.decision.direction} on the candle ending ${et(Date.parse(d.decision.candleEnd))} (close ${d.decision.close}); box ${et(Date.parse(d.box.start))}-${et(Date.parse(d.box.end))} ${d.box.low}-${d.box.high}${d.entries ? `; entry A ${d.entries.A.price} x ${d.entries.A.shares}, B ${d.entries.B.price} x ${d.entries.B.shares}, stop ${d.entries.stop} (journal only)` : ""}`);
    else if (e.type === "box_voided") lines.push(`${at}  ${d.symbol}  BOX voided: ${d.voided.reason}`);
    else if (e.type === "box_expired") lines.push(`${at}  ${d.symbol}  BOX still open at the close ${d.box.low}-${d.box.high}`);
  }
  if (result.halted) lines.push(`halted: ${result.halted}`);
  return lines;
}

/** The private fixtures for one date, refused unless complete: every symbol's regular-session minute bars, one per minute. */
export function loadFixtures(dir: string, date: string): { regular: BarsFile; symbols: string[] } {
  if (!existsSync(dir)) throw new Error(`Replay fixtures not found at ${dir}. They are private; pass --fixtures or set ASTRA_REPLAY_FIXTURES.`);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const counts = (manifest.files as any[] | undefined)?.find(f => f.name === "bars-minute-regular.json")?.counts as Record<string, number> | undefined;
  if (!counts || !Object.keys(counts).length) throw new Error("Replay manifest lists no regular-session bars");
  const regular = JSON.parse(readFileSync(join(dir, "bars-minute-regular.json"), "utf8")) as BarsFile;
  const { open, close } = sessionTimes(date), minutes = (close - open) / 60000;
  for (const [symbol, count] of Object.entries(counts)) {
    const bars = regular.data?.results?.find(r => r.symbol === symbol)?.bars ?? [], at = new Set(bars.map(b => Date.parse(b.begins_at)));
    if (count !== minutes || bars.length !== minutes || !Array.from({ length: minutes }, (_, i) => open + i * 60000).every(t => at.has(t)))
      throw new Error(`Replay fixture for ${symbol} on ${date} has ${bars.length} of ${minutes} regular-session minute bars`);
  }
  return { regular, symbols: Object.keys(counts) };
}

/** The support-box replay's private fixtures: `<dir>/support-box.json` = { regular: BarsFile with volume, the sessions before the day and the day itself;
 *  daily: { SYMBOL: split-adjusted daily bars before the day } }. Never in this repository. */
export function loadBoxFixtures(dir: string): { regular: BarsFile; daily: Record<string, DailyBars>; symbols: string[] } {
  if (!existsSync(dir)) throw new Error(`Replay fixtures not found at ${dir}. They are private; pass --fixtures or set ASTRA_REPLAY_FIXTURES.`);
  const file = JSON.parse(readFileSync(join(dir, "support-box.json"), "utf8"));
  const symbols = (file.regular?.data?.results ?? []).map((r: { symbol: string }) => r.symbol) as string[];
  if (!symbols.length || symbols.some(s => !file.daily?.[s]?.time?.length)) throw new Error("The support-box fixtures need minute bars and daily bars for every symbol");
  return { regular: file.regular, daily: file.daily, symbols };
}
const BOX_EVENTS = new Set(["configured", "started", "universe_checked", "supports", "box_formed", "box_decided", "box_voided", "box_expired", "candle_unobserved",
  "heartbeat", "data_gap", "data_restored", "session_ended", "stopped", "run_halted"]);
/** The support-box replay's claims. They compare the live runtime with the offline scan of the SAME minute bars (`scanDay`). The replay
 *  polls every second along a modeled path that touches each bar's open, low, high and close, so the observed ranges equal the bars':
 *  this checks the plumbing (grid, bucketing, ordering, support lookups, journal), not live fidelity (docs/decisions/0002). */
export function checkBoxes(result: ReplayResult, regular: BarsFile, daily: Record<string, DailyBars>, date: string, symbols: string[], settings: StrategySettings = {}): Claim[] {
  const claims: Claim[] = [], add = (id: string, claim: string, pass: boolean, detail: string) => claims.push({ id, claim, modeled: false, pass, detail });
  const config = boxConfig(date, symbols, settings as never), of = (type: string, symbol: string) => result.events.filter(e => e.type === type && e.data?.symbol === symbol);
  const stray = result.events.filter(e => !BOX_EVENTS.has(e.type));
  add("clean", "the run completed with no halt, no data gap, no order, no position and only the documented event types", !result.halted && result.complete && result.ordersSubmitted === 0 &&
    !stray.length && !result.events.some(e => e.type === "data_gap"), result.halted ? `halted: ${result.halted}` : stray.length ? `unexpected: ${stray.map(e => e.type).join(", ")}` : "clean");
  for (const symbol of symbols) {
    const bars = (regular.data.results.find(r => r.symbol === symbol)?.bars ?? []) as BoxBar[], reference = scanDay(bars, daily[symbol]!, config);
    const verdicts = of("universe_checked", symbol);
    const expected = reference.unavailable ? "unavailable" : reference.runaway ? (reference.runaway.fired ? "runaway" : "not_runaway") : "watched";
    add(`${symbol}-verdict`, `${symbol} gets exactly one verdict, and it is the offline scan's: ${expected}`, verdicts.length === 1 && verdicts[0]!.data.status === expected,
      verdicts.map(v => v.data.status).join(",") || "none");
    if (expected === "not_runaway" || expected === "unavailable") { add(`${symbol}-no-boxes`, `${symbol} is ${expected === "unavailable" ? "unavailable" : "not a runaway"}, so no box is searched for`, !result.events.some(e => e.type.startsWith("box_") && e.data?.symbol === symbol), "none expected"); continue; }
    const engine = result.events.filter(e => ["box_decided", "box_voided", "box_expired"].includes(e.type) && e.data?.symbol === symbol).map(e => e.data);
    const key = (b: any) => JSON.stringify([b.box.start, b.box.end, b.box.low, b.box.high, b.status === "live" ? "expired" : b.status, b.decision?.direction ?? null, b.decision?.candleEnd ?? null]);
    const want = reference.boxes.map(key), got = engine.map(b => key({ ...b, status: b.status === "live" ? "expired" : b.status }));
    add(`${symbol}-boxes`, `${symbol}'s boxes (start, end, floor, high, outcome, decision candle) equal the offline scan of the same bars`, JSON.stringify(want) === JSON.stringify(got),
      `${engine.length} from the run, ${reference.boxes.length} offline${want.join() === got.join() ? "" : `; run ${got.join(" | ")} vs offline ${want.join(" | ")}`}`);
    const unobserved = of("candle_unobserved", symbol).length;
    add(`${symbol}-observed`, `${symbol} had no unobserved candle`, unobserved === 0, `${unobserved} unobserved`);
  }
  return claims;
}

const USAGE = "usage: npm run replay -- <YYYY-MM-DD> [--fixtures DIR] [--iv SYMBOL=0.9,...] [--lag SECONDS] [--strategy opening-range-options|support-box] [--check] [--out DIR]";
// Strategy 0.10.0 on the article's day, read off the bars by the same rules: CRWV breaks out first and enters; SOXL
// closes a candle a range height under its low at 9:44 and is out; MU never breaks out (its 14:50 cancel lands after
// the 11:00 entry window, so the window, not the cancel, ends its day by default).
const ORACLE_1 = { date: "2026-09-08", enters: ["CRWV"], cancels: ["SOXL"] };
async function main(argv: string[]): Promise<number> {
  const flag = (name: string) => {
    const i = argv.indexOf(name); if (i < 0) return undefined;
    const value = argv[i + 1]; if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value\n${USAGE}`);
    return value;
  };
  const positive = (text: string, name: string, zero = false) => {
    const v = Number(text); if (!Number.isFinite(v) || v < 0 || (!zero && v === 0)) throw new Error(`${name} must be a ${zero ? "non-negative" : "positive"} number\n${USAGE}`);
    return v;
  };
  const date = argv[0];
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { console.error(USAGE); return 2; }
  const root = flag("--fixtures") ?? process.env.ASTRA_REPLAY_FIXTURES;
  if (!root) { console.error(`Replay fixtures are private and not in this repository: pass --fixtures DIR or set ASTRA_REPLAY_FIXTURES.\n${USAGE}`); return 1; }
  const strategy = flag("--strategy") ?? "opening-range-options";
  if (strategy === "support-box") {
    // Watch-only: the live runtime on real minute bars (private fixtures), checked against the offline scan of the same bars.
    const dir = join(root, date), box = loadBoxFixtures(dir), out = flag("--out") ?? join(dir, "replay-output");
    mkdirSync(out, { recursive: true });
    const result = await runReplay({ date, symbols: box.symbols, regular: box.regular, volatility: {}, barLagMs: 0, settings: {}, dataDir: mkdtempSync(join(out, "box-")), strategyId: "support-box", daily: box.daily });
    console.log(`REPLAY ${date}: support-box (watch-only) on real minute bars from ${dir}; observed ranges follow the modeled minute path, polled every second (docs/decisions/0002)`);
    for (const line of timeline(result)) console.log(line);
    if (!argv.includes("--check")) return 0;
    const claims = checkBoxes(result, box.regular, box.daily, date, box.symbols);
    for (const k of claims) console.log(`  ${k.pass ? "PASS" : "FAIL"}  ${k.claim}: ${k.detail}`);
    return claims.every(k => k.pass) ? 0 : 1;
  }
  if (strategy !== "opening-range-options") { console.error(USAGE); return 2; }
  const dir = join(root, date), { regular, symbols } = loadFixtures(dir, date);
  const volatility = Object.fromEntries(symbols.map(s => [s, 0.9]));
  for (const pair of (flag("--iv") ?? "").split(",").filter(Boolean)) {
    const [s, v] = pair.split("="); if (!s || !symbols.includes(s)) throw new Error(`--iv names ${s}, which the fixtures do not have\n${USAGE}`);
    volatility[s] = positive(v ?? "", `--iv ${s}`);
  }
  const lagMs = positive(flag("--lag") ?? "0", "--lag", true) * 1000, out = flag("--out") ?? join(dir, "replay-output");
  mkdirSync(out, { recursive: true });
  const run = (label: string, extra: { volatility?: Record<string, number>; barLagMs?: number; settings?: StrategySettings } = {}) =>
    runReplay({ date, symbols, regular, volatility: extra.volatility ?? volatility, barLagMs: extra.barLagMs ?? lagMs, settings: extra.settings ?? {},
      dataDir: mkdtempSync(join(out, `${label}-`)) });
  console.log(`REPLAY ${date}: ${symbols.join(", ")} on real minute bars from ${dir}`);
  console.log(`Option prices are MODELED: Black-Scholes, zero rate, calendar time to 4:00 pm ET on expiry, IV ${symbols.map(s => `${s} ${volatility[s]}`).join(", ")},`);
  console.log(`a 4% bid-ask spread, 50 contracts at the ask, and an assumed strike grid. Intra-minute prices follow open, low, high, close.`);
  const base = await run("base");
  for (const line of timeline(base)) console.log(line);
  if (!argv.includes("--check")) return 0;
  if (date !== ORACLE_1.date) { console.error(`--check knows DONE-ORACLE 1 (${ORACLE_1.date}) only`); return 2; }
  const report = (title: string, claims: Claim[]) => {
    console.log(`\n${title}`);
    for (const k of claims) console.log(`  ${k.pass ? "PASS" : "FAIL"}  ${k.modeled ? "[MODELED] " : ""}${k.claim}: ${k.detail}`);
    return claims.every(k => k.pass);
  };
  let ok = report("DONE-ORACLE 1", checkOracle(base, regular, date, {}, ORACLE_1));
  ok = report(`Bars published 45 s late (the range-retry path)`, checkOracle(await run("lag45", { barLagMs: 45000 }), regular, date, {}, ORACLE_1)) && ok;
  const wide = await run("window390", { settings: { entryWindowMinutes: 390 } });
  const allDay = { enters: ORACLE_1.enters, cancels: ["SOXL", "MU"] };
  ok = report("Entries allowed all day: the cancel rule, not the entry window, keeps SOXL and MU out",
    checkOracle(wide, regular, date, { entryWindowMinutes: 390 }, allDay).filter(k => allDay.cancels.some(s => k.id.startsWith(s)))) && ok;
  for (const iv of [0.5, 0.7, 1.2]) {
    const sweep = checkOracle(await run(`iv${iv}`, { volatility: Object.fromEntries(symbols.map(s => [s, iv])) }), regular, date, {}, ORACLE_1);
    report(`Sensitivity (informational): every stock at IV ${iv}`, sweep.filter(k => k.modeled || k.id === "clean"));
  }
  console.log(`\n${ok ? "DONE-ORACLE 1 holds" : "DONE-ORACLE 1 does NOT hold"} (journals under ${out})`);
  return ok ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).then(code => process.exit(code), (error: unknown) => { console.error(String((error as Error)?.message ?? error)); process.exit(1); });
