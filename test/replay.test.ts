import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ReplayMarket, callValue, normalCdf, pathPrice, type BarsFile, type MinuteBar } from "../src/replay-market.ts";
import { checkOracle, loadFixtures, runReplay, type ReplayResult } from "../src/replay.ts";
import { sessionTimes } from "../src/daily-history.ts";

// Invented prices only: the real replay data is private and never enters this repository.
const date = "2026-09-08", { open, close } = sessionTimes(date);
const bar = (minute: number, o: number, h: number, l: number, c: number): MinuteBar => ({ begins_at: new Date(open + minute * 60000).toISOString(),
  open_price: String(o), high_price: String(h), low_price: String(l), close_price: String(c), session: "reg" });
/** A full session of bars through the given minute closes (each bar spans its open and close with a small wick). */
function day(first: MinuteBar[], closes: (minute: number) => number): MinuteBar[] {
  const bars = [...first];
  for (let m = first.length; m < 390; m++) {
    const o = +bars[m - 1]!.close_price, c = Math.round(closes(m) * 100) / 100;
    bars.push(bar(m, o, Math.max(o, c) + 0.05, Math.min(o, c) - 0.05, c));
  }
  return bars;
}
const ramp = (from: number, to: number, a: number, b: number) => (m: number) => m <= a ? from : m >= b ? to : from + (to - from) * (m - a) / (b - a);
// DEMOA holds its 49.50-51.20 range, breaks out at 9:44 and rallies about 12% before easing into the close.
const demoA = day([bar(0, 50, 51, 49.5, 50.8), bar(1, 50.8, 51.2, 50.2, 51)], m => m < 14 ? 50.8 : m < 210 ? ramp(51.5, 57, 14, 210)(m) : ramp(57, 55, 210, 389)(m));
// DEMOB loses its 60-61 low in the third minute, then rallies above its high at 10:00, inside the entry window.
const demoB = day([bar(0, 60.5, 61, 60, 60.6), bar(1, 60.6, 60.9, 60.1, 60.2), bar(2, 60.2, 60.4, 59.8, 60.3)], m => m < 30 ? 60.3 : ramp(61.5, 63, 30, 120)(m));
// DEMOC's third minute breaks BOTH ends of its 70-71 range and closes lower: nothing decides which came first.
const demoC = day([bar(0, 70.5, 71, 70, 70.6), bar(1, 70.6, 70.9, 70.2, 70.6), bar(2, 70.6, 71.4, 69.8, 70.5)], m => m < 20 ? 70.5 : 72);
const bars: BarsFile = { data: { results: [["DEMOA", demoA], ["DEMOB", demoB], ["DEMOC", demoC]].map(([symbol, list]) =>
  ({ symbol: symbol as string, interval: "minute", bounds: "regular", bars: list as MinuteBar[] })) } };
// One replay of the invented day through the paper service, shared by the tests below; coarse polling keeps it quick.
const settings = { pollMs: 20000, maxQuoteAgeMs: 20000, maxObservationGapMs: 60000 };
const dataDir = mkdtempSync(join(tmpdir(), "astra-replay-test-")); after(() => rmSync(dataDir, { recursive: true, force: true }));
let shared: Promise<ReplayResult> | undefined;
const replayed = () => shared ??= runReplay({ date, symbols: ["DEMOA", "DEMOB", "DEMOC"], regular: bars,
  volatility: { DEMOA: 0.9, DEMOB: 0.9, DEMOC: 0.9 }, barLagMs: 0, settings, dataDir });

test("the modeled minute path visits the low before the high, whichever way the bar closes", () => {
  const down = bar(0, 10, 12, 8, 9);
  assert.deepEqual([0, 20, 40, 59].map(s => pathPrice(down, s)), [10, 8, 12, 9]);
  assert.equal(pathPrice(down, 10), 9);
  assert.ok([...Array(20).keys()].every(s => pathPrice(down, s) >= 8 && pathPrice(down, s) <= 10), "no high before the low");
});
test("Black-Scholes calls behave: symmetric normal, near 0.4 S sigma sqrt(T) at the money, intrinsic at expiry", () => {
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-7 && Math.abs(normalCdf(1.96) - 0.975) < 1e-4 && Math.abs(normalCdf(-1) + normalCdf(1) - 1) < 1e-7);
  const t = 3 / 365, atm = callValue(100, 100, 0.9, t);
  assert.ok(Math.abs(atm / (0.4 * 100 * 0.9 * Math.sqrt(t)) - 1) < 0.02, String(atm));
  assert.ok(callValue(105, 100, 0.9, t) > atm && callValue(95, 100, 0.9, t) < atm);
  assert.equal(callValue(105, 100, 0.9, 0), 5);
});
test("the replay market trades every second, publishes bars after their minute, and quotes modeled calls within the 20-id limit", async () => {
  let now = open + 120000; const market = new ReplayMarket({ regular: bars, clock: () => now, volatility: { DEMOA: 0.9 }, barLagMs: 45000 });
  const [q] = await market.quotes(["DEMOA"]);
  assert.deepEqual([q!.price, q!.tradeAt, q!.fresh], [51, new Date(open + 120000).toISOString(), true]);
  const published = async () => ((await market.bars(["DEMOA"], open, open + 120000, false)) as BarsFile).data.results[0]!.bars.length;
  assert.equal(await published(), 1, "the second minute's bar is not published until 45 s after it ends");
  now = open + 165000; assert.equal(await published(), 2);
  const catalog = await market.contracts("DEMOA", date);
  assert.equal(catalog.expiration, "2026-09-11");
  assert.ok(catalog.contracts.every(k => /^[a-f0-9-]{36}$/.test(k.id)) && catalog.contracts.some(k => k.strike === 50));
  const atm = catalog.contracts.find(k => k.strike === 51)!, far = catalog.contracts.find(k => k.strike === 60)!;
  const [a, f] = await market.optionQuotes([atm.id, far.id]);
  assert.ok(a!.bid > 0 && a!.ask > a!.bid && f!.ask < a!.ask, JSON.stringify([a, f]));
  await assert.rejects(market.optionQuotes(catalog.contracts.slice(0, 21).map(k => k.id)), /Invalid option IDs/);
});
test("a replay through the paper service meets its claims: the breakout enters, low failures never do, even a both-break bar", async () => {
  const result = await replayed();
  const claims = checkOracle(result, bars, date, settings, { enters: ["DEMOA"], lowFails: ["DEMOB", "DEMOC"] });
  assert.deepEqual(claims.filter(k => !k.pass).map(k => `${k.id}: ${k.detail}`), []);
  assert.deepEqual(claims.filter(k => k.modeled).map(k => k.id), ["DEMOA-size", "DEMOA-first-target", "DEMOA-breakeven", "DEMOA-closed"]);
  assert.ok(result.events.some(e => e.type === "setup_disqualified" && e.data.symbol === "DEMOC" && e.data.reason === "opening_low_failed"),
    "the both-break bar counts as a low failure, never an entry");
});
test("the claims fail for the wrong reasons: a write-off, a stock dropped by another rule, a late or missing entry", async () => {
  const result = await replayed();
  const lastSale = result.events.filter(e => e.type === "paper_sale").at(-1)!;
  const writtenOff = { ...result, events: [...result.events.filter(e => e !== lastSale), { at: close, type: "written_off", data: { symbol: "DEMOA", quantity: lastSale.data.quantity } }] };
  const failed = checkOracle(writtenOff, bars, date, settings, { enters: ["DEMOA"], lowFails: ["DEMOB"] }).filter(k => !k.pass).map(k => k.id);
  assert.deepEqual(failed, ["clean", "DEMOA-closed"]);
  assert.ok(checkOracle(result, bars, date, settings, { enters: ["DEMOB"], lowFails: [] }).some(k => k.id === "DEMOB-entry" && !k.pass));
  // DEMOB dropped by the entry window instead of its opening low must not count as the low rule working.
  const windowed = { ...result, events: result.events.map(e => e.type === "setup_disqualified" && e.data.symbol === "DEMOB" ? { ...e, data: { ...e.data, reason: "entry_window_closed" } } : e) };
  assert.ok(checkOracle(windowed, bars, date, settings, { enters: [], lowFails: ["DEMOB"] }).some(k => k.id === "DEMOB-low" && !k.pass));
  // An entry one poll after the first observed trade above the high is not the breakout entry.
  const late = { ...result, events: result.events.map(e => e.type === "option_selection" && e.data.symbol === "DEMOA"
    ? { ...e, data: { ...e.data, stock: { ...e.data.stock, tradeAt: new Date(Date.parse(e.data.stock.tradeAt) + settings.pollMs).toISOString() } } } : e) };
  assert.ok(checkOracle(late, bars, date, settings, { enters: ["DEMOA"], lowFails: [] }).some(k => k.id === "DEMOA-entry" && !k.pass));
});
test("the replay refuses missing or incomplete fixtures loudly instead of skipping", () => {
  const root = mkdtempSync(join(tmpdir(), "astra-replay-fixtures-"));
  try {
    const cli = (...args: string[]) => spawnSync(process.execPath, ["src/replay.ts", ...args], { encoding: "utf8", env: { ...process.env, ASTRA_REPLAY_FIXTURES: "" } });
    const none = cli(date);
    assert.equal(none.status, 1); assert.match(none.stderr, /private.*--fixtures/s);
    assert.equal(cli(date, "--fixtures", join(root, "missing")).status, 1);
    mkdirSync(join(root, date));
    writeFileSync(join(root, date, "manifest.json"), JSON.stringify({ files: [{ name: "bars-minute-regular.json", counts: { DEMOA: 390 } }] }));
    const truncated: BarsFile = { data: { results: [{ symbol: "DEMOA", interval: "minute", bounds: "regular", bars: demoA.slice(0, 200) }] } };
    writeFileSync(join(root, date, "bars-minute-regular.json"), JSON.stringify(truncated));
    assert.throws(() => loadFixtures(join(root, date), date), /200 of 390/);
    const partial = cli(date, "--fixtures", root);
    assert.equal(partial.status, 1); assert.match(partial.stderr, /200 of 390/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
