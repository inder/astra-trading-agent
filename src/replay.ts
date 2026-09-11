#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { TradingAgentService } from "./agent-service.ts";
import { sessionTimes } from "./daily-history.ts";
import { openingRangeConfig, type StrategySettings } from "./orb-config.ts";
import { ReplayMarket, pathPrice, type BarsFile } from "./replay-market.ts";

// Replays one session through Astra's own paper service: REAL minute bars (read from a private fixtures folder, never
// this repository) drive the stock side, and option prices are MODELED. `--check` states which claims each result
// decides and whether they hold; it knows no prices, only the structure the fixtures imply at run time.

export interface ReplayInput {
  date: string; symbols: string[]; regular: BarsFile; volatility: Record<string, number>;
  barLagMs: number; settings: StrategySettings; dataDir: string;
}
export interface ReplayEvent { at: number; type: string; data: any }
export interface ReplayResult {
  events: ReplayEvent[]; breakevenAt: Record<string, number>; halted: string | null; complete: boolean;
  ordersSubmitted: number; pollMs: number; firstTick: number;
}
/** Runs the session tick by tick on a simulated clock, from a minute before the open (catalog prefetch) to the close. */
export async function runReplay(input: ReplayInput): Promise<ReplayResult> {
  const { open, close } = sessionTimes(input.date), pollMs = input.settings.pollMs ?? 1000, firstTick = open - 60000;
  // Claims compare tick times with whole seconds and whole minutes, so ticks must land on both.
  if (pollMs % 1000 || 60000 % pollMs) throw new Error("Replay needs a poll interval of whole seconds that divides a minute");
  let now = firstTick; const clock = () => now;
  const market = new ReplayMarket({ regular: input.regular, clock, volatility: input.volatility, barLagMs: input.barLagMs });
  const service = new TradingAgentService(input.dataDir, undefined, undefined, { market, clock, ready: () => true, auto: false });
  const runId = "replay", breakevenAt: Record<string, number> = {}; let halted: string | null = null;
  try {
    service.paper.configure({ runId, strategyId: "opening-range-options", date: input.date, symbols: input.symbols, includePremarket: false, ...input.settings });
    await service.paper.start(runId);
    for (;;) {
      let status;
      try { status = await service.paper.tick(runId); } catch (error) { halted = String((error as Error).message); break; }
      for (const p of status.view.positions) if (p.stage === "breakeven" && breakevenAt[p.symbol] === undefined) breakevenAt[p.symbol] = now;
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
    return { events, breakevenAt, halted: halted && stoppedBy ? `${halted}: ${stoppedBy}` : halted, complete: final.status === "completed",
      ordersSubmitted: final.ordersSubmitted, pollMs, firstTick };
  } finally { await service.close(); }
}

/** What the fixtures themselves imply for each stock: its opening range and the first second of the modeled path above
 *  the high or below the low (the same path the replay trades on). */
export function openingOutcomes(regular: BarsFile, date: string) {
  const symbols = regular.data.results.map(r => r.symbol);
  const rangeEnd = sessionTimes(date).open + openingRangeConfig({ date, symbols, includePremarketLeadMinutes: 0 }).openingRangeMinutes * 60000;
  return Object.fromEntries(regular.data.results.map(r => {
    const bars = [...r.bars].sort((a, b) => Date.parse(a.begins_at) - Date.parse(b.begins_at));
    const first = bars.filter(b => Date.parse(b.begins_at) < rangeEnd);
    const range = { high: Math.max(...first.map(b => +b.high_price)), low: Math.min(...first.map(b => +b.low_price)) };
    let firstAbove: number | null = null, firstBelow: number | null = null;
    for (const bar of bars.filter(b => Date.parse(b.begins_at) >= rangeEnd)) {
      for (let s = 0; s < 60 && (firstAbove === null || firstBelow === null); s++) {
        const price = pathPrice(bar, s), at = Date.parse(bar.begins_at) + s * 1000;
        if (firstBelow === null && price < range.low) firstBelow = at;
        if (firstAbove === null && price > range.high) firstAbove = at;
      }
    }
    return [r.symbol, { range, firstAbove, firstBelow }];
  }));
}

export interface Claim { id: string; claim: string; modeled: boolean; pass: boolean; detail: string }
/** DONE-ORACLE 1's claims for the article's day, checked structurally: which stock must enter, which must lose its
 *  opening low first, and what the exits must look like. Claims decided by modeled option prices say so. */
export function checkOracle(result: ReplayResult, regular: BarsFile, date: string, settings: StrategySettings,
  expected: { enters: string[]; lowFails: string[] }): Claim[] {
  const { open, close } = sessionTimes(date), c = openingRangeConfig({ date, symbols: [...expected.enters, ...expected.lowFails], includePremarketLeadMinutes: 0, ...settings });
  const outcomes = openingOutcomes(regular, date), claims: Claim[] = [], rangeEnd = open + c.openingRangeMinutes * 60000;
  const missing = [...expected.enters, ...expected.lowFails].filter(s => !outcomes[s]);
  if (missing.length) throw new Error(`The fixtures have no bars for ${missing.join(", ")}`);
  const of = (type: string, symbol?: string) => result.events.filter(e => e.type === type && (!symbol || e.data?.symbol === symbol));
  const add = (id: string, claim: string, modeled: boolean, pass: boolean, detail: string) => claims.push({ id, claim, modeled, pass, detail });
  // Nothing may pass by default: a write-off, a deferred sale, a data gap or a halt would also leave nothing held at the close.
  const unclean = [...of("written_off"), ...of("sale_deferred"), ...of("data_gap"),
    ...of("setup_disqualified").filter(e => ["observation_gap", "range_unavailable", "late_first_quote"].includes(e.data.reason))];
  add("clean", "the session ran to the close with no write-off, deferred sale, data gap, halt or data-driven disqualification", false,
    !result.halted && result.complete && result.ordersSubmitted === 0 && !unclean.length,
    result.halted ? `halted: ${result.halted}` : unclean.map(e => e.type + (e.data.reason ? `:${e.data.reason}` : "")).join(", ") || "clean");
  for (const symbol of expected.lowFails) {
    const o = outcomes[symbol]!, d = of("setup_disqualified", symbol).find(e => e.data.reason === "opening_low_failed");
    add(`${symbol}-low`, `${symbol} trades below its opening low first and is out for the day within the first minute after the range`, false,
      !!d && o.firstBelow !== null && (o.firstAbove === null || o.firstBelow < o.firstAbove) && d.at >= o.firstBelow && d.at < rangeEnd + 60000 &&
        !of("paper_entry", symbol).length,
      d ? `opening_low_failed at ${et(d.at)}${o.firstAbove !== null ? `; its high breaks only at ${et(o.firstAbove)}` : ""}` : "not disqualified for its opening low");
  }
  for (const symbol of expected.enters) {
    const o = outcomes[symbol]!, entries = of("paper_entry", symbol), selection = of("option_selection", symbol)[0];
    const breakTick = o.firstAbove === null ? null : result.firstTick + Math.ceil((o.firstAbove - result.firstTick) / result.pollMs) * result.pollMs;
    const enteredAt = selection ? Date.parse(selection.data.stock.tradeAt) : null;
    add(`${symbol}-entry`, `${symbol} holds its opening low and buys at the first observed trade above its opening high, before 10:00 ET`, false,
      entries.length === 1 && breakTick !== null && (o.firstBelow === null || o.firstAbove! < o.firstBelow) && enteredAt === breakTick && breakTick < open + 30 * 60000,
      entries.length ? `entered at ${et(enteredAt!)} (first trade above the high at ${o.firstAbove === null ? "never" : et(o.firstAbove)})` : "no entry");
    const entry = entries[0]?.data, n = entry?.quantity ?? 0;
    add(`${symbol}-size`, `${symbol} buys at least ${c.minimumContracts} calls near the money within the per-trade cap`, true,
      !!entry && n >= c.minimumContracts && entry.committedCents <= c.budgetCentsPerPosition && Math.abs(entry.strike / entry.stockPrice - 1) <= 0.05,
      entry ? `${n} x ${entry.strike} calls, committed $${(entry.committedCents / 100).toFixed(2)}` : "no entry");
    const sales = of("paper_sale", symbol), firstTarget = sales.find(s => s.data.reason === "profit_target");
    add(`${symbol}-first-target`, `${symbol} sells half its calls (rounded up) at ${c.firstTargetMultiple}x`, true,
      !!firstTarget && firstTarget.data.targets?.[0] === c.firstTargetMultiple && firstTarget.data.quantity === Math.ceil(n / 2),
      firstTarget ? `${firstTarget.data.quantity} sold at ${et(firstTarget.at)} for ${firstTarget.data.targets.join("x, ")}x` : "no target reached");
    add(`${symbol}-breakeven`, `${symbol}'s stop moves to breakeven after the first target`, true,
      !!firstTarget && result.breakevenAt[symbol] !== undefined && result.breakevenAt[symbol]! >= firstTarget.at,
      result.breakevenAt[symbol] !== undefined ? `breakeven from ${et(result.breakevenAt[symbol]!)}` : "never at breakeven");
    const sold = sales.reduce((sum, s) => sum + s.data.quantity, 0), last = sales.at(-1);
    add(`${symbol}-closed`, `${symbol} is fully sold by 3:59 ET by a target, its breakeven stop or the close-out`, true,
      n > 0 && sold === n && !!last && last.at <= close - c.flattenLeadMinutes * 60000 && ["profit_target", "breakeven_stop", "session_close"].includes(last.data.reason),
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
    if (e.type === "opening_range") lines.push(`${at}  ${d.symbol}  opening range ${d.range.low}-${d.range.high}`);
    else if (e.type === "setup_disqualified") lines.push(`${at}  ${d.symbol}  out for the day: ${d.reason}${d.price ? ` (traded ${d.price})` : d.lowSeen ? ` (low ${d.lowSeen} seen while the range was pending)` : ""}`);
    else if (e.type === "entry_skipped") lines.push(`${at}  ${d.symbol}  entry skipped: ${d.reason}`);
    else if (e.type === "paper_entry") lines.push(`${at}  ${d.symbol}  BUY ${d.quantity} x ${d.strike} call exp ${d.expiration} at ${d.assumedFill} MODELED; stock ${d.stockPrice}; committed ${dollars(d.committedCents)}`);
    else if (e.type === "exit_triggered") lines.push(`${at}  ${d.symbol}  ${d.exit} triggered at stock ${d.stockPrice}`);
    else if (e.type === "paper_sale") lines.push(`${at}  ${d.symbol}  SELL ${d.quantity} (${d.reason}${d.targets ? ` ${d.targets.join("x, ")}x` : ""}) at ${d.assumedFill} MODELED; stock ${d.stockPrice}; P&L ${dollars(d.realizedPnlCents)}`);
    else if (e.type === "written_off") lines.push(`${at}  ${d.symbol}  WRITTEN OFF ${d.quantity}: ${dollars(d.realizedPnlCents)}`);
    else if (e.type === "run_halted") lines.push(`${at}  halted: ${d.detail}`);
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

const USAGE = "usage: npm run replay -- <YYYY-MM-DD> [--fixtures DIR] [--iv SYMBOL=0.9,...] [--lag SECONDS] [--check] [--out DIR]";
const ORACLE_1 = { date: "2026-09-08", enters: ["CRWV"], lowFails: ["SOXL", "MU"] };
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
  ok = report("Entries allowed all day: the opening-low rule, not the entry window, keeps SOXL and MU out",
    checkOracle(wide, regular, date, { entryWindowMinutes: 390 }, ORACLE_1).filter(k => ORACLE_1.lowFails.some(s => k.id.startsWith(s)))) && ok;
  for (const iv of [0.5, 0.7, 1.2]) {
    const sweep = checkOracle(await run(`iv${iv}`, { volatility: Object.fromEntries(symbols.map(s => [s, iv])) }), regular, date, {}, ORACLE_1);
    report(`Sensitivity (informational): every stock at IV ${iv}`, sweep.filter(k => k.modeled || k.id === "clean"));
  }
  console.log(`\n${ok ? "DONE-ORACLE 1 holds" : "DONE-ORACLE 1 does NOT hold"} (journals under ${out})`);
  return ok ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).then(code => process.exit(code), (error: unknown) => { console.error(String((error as Error)?.message ?? error)); process.exit(1); });
