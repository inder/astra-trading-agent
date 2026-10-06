import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { aggregate, bucketStart, dayCandle, mergeBars } from "../src/chart-aggregate.js";
import { ChartServer } from "../src/chart-server.ts";
import { ChartStore } from "../src/chart-store.ts";
import { MAX_MINUTE_WINDOW_MS, minuteWindows, normalizeMinuteBars, sessionsThrough, type MinuteBar } from "../src/intraday-bars.ts";
import { chartSettingsSchema, LiveCharts, type ChartEvent, type ChartSource } from "../src/live-chart.ts";
import { normalizeMarketQuotes, type EquityMarketQuote } from "../src/market-data.ts";

// Real Robinhood replies, captured 2026-10-04 for RDDT's 2026-10-02 session.
const regular = JSON.parse(readFileSync("test/fixtures/robinhood-minute-regular.json", "utf8"));
const extended = JSON.parse(readFileSync("test/fixtures/robinhood-minute-extended-edges.json", "utf8"));
const OCT2 = { open: Date.parse("2026-10-02T13:30:00Z"), close: Date.parse("2026-10-02T20:00:00Z") };
const OCT5 = { open: Date.parse("2026-10-05T13:30:00Z"), close: Date.parse("2026-10-05T20:00:00Z") };
const min = (n: number) => n * 60000;

test("captured minute bars: gap-fill and out-of-session bars are hidden, volume is a number", () => {
  const bars = normalizeMinuteBars(regular, "RDDT");
  // 390 regular minutes, 6 of them interpolated gap-fill.
  assert.equal(regular.data.results[0].bars.length, 390);
  assert.equal(bars.length, 384);
  assert.ok(!bars.some(b => b.t === Date.parse("2026-10-02T15:33:00Z")), "the interpolated 11:33 ET minute is hidden");
  assert.deepEqual(bars[0], { t: OCT2.open, o: 149.775, h: 149.775, l: 149.775, c: 149.775, v: 200 });
  assert.ok(bars.every(b => Number.isInteger(b.v) && b.l <= Math.min(b.o, b.c) && b.h >= Math.max(b.o, b.c)));
  // Extended-hours reply around the open and the close: only the regular-session minutes survive.
  const edges = normalizeMinuteBars(extended, "RDDT");
  assert.ok(edges.length > 0 && edges.every(b => b.t >= OCT2.open && b.t < OCT2.close));
  assert.equal(edges[0]!.t, OCT2.open);
});

test("minute bars: a wrong series is refused, not charted", () => {
  const result = regular.data.results[0];
  assert.throws(() => normalizeMinuteBars({ data: { results: [{ ...result, interval: "5minute" }] } }, "RDDT"), /Minute bars unavailable/);
  assert.throws(() => normalizeMinuteBars(regular, "QCOM"), /Minute bars unavailable/);
  assert.throws(() => normalizeMinuteBars({ data: { results: [{ ...result, bars: [result.bars[1], result.bars[0]] }] } }, "RDDT"), /out of order/);
  // A bar whose close sits outside its own high-low range is a bad bar, dropped.
  const bad = { ...result.bars[0], close_price: "500" };
  assert.equal(normalizeMinuteBars({ data: { results: [{ ...result, bars: [bad, result.bars[1]] }] } }, "RDDT").length, 1);
});

test("candle sizes are rolled up from 1-minute bars and aligned to the 9:30 open", () => {
  const bars = normalizeMinuteBars(regular, "RDDT");
  const counts = Object.fromEntries([1, 2, 5, 15, 30].map(m => [m, aggregate(bars, m, [OCT2]).length]));
  assert.deepEqual(counts, { 1: 384, 2: 195, 5: 78, 15: 26, 30: 13 });
  const first = aggregate(bars, 30, [OCT2])[0]!, inside = bars.filter(b => b.t < OCT2.open + min(30));
  assert.deepEqual(first, { t: OCT2.open, o: inside[0]!.o, h: Math.max(...inside.map(b => b.h)), l: Math.min(...inside.map(b => b.l)),
    c: inside.at(-1)!.c, v: inside.reduce((n, b) => n + b.v, 0) });
  assert.equal(aggregate(bars, 30, [OCT2]).at(-1)!.t, Date.parse("2026-10-02T19:30:00Z"));
  // Every 15-minute candle starts on a quarter hour from the open, never at the first traded minute after a gap.
  assert.ok(aggregate(bars, 15, [OCT2]).every(c => (c.t - OCT2.open) % min(15) === 0));
  // Outside every session: left out, not forced into a candle.
  assert.equal(bucketStart(OCT2.open - 60000, 5, [OCT2]), null);
  assert.equal(aggregate([{ t: OCT2.close, o: 1, h: 1, l: 1, c: 1, v: 1 }], 5, [OCT2]).length, 0);
  // Early close (1:00 pm ET, day after Thanksgiving): the last 30-minute candle is 12:30-1:00.
  const [nov27] = sessionsThrough("2026-11-27", 1);
  assert.equal(nov27!.close - nov27!.open, min(210));
  assert.equal(bucketStart(nov27!.close - 60000, 30, [nov27!]), nov27!.close - min(30));
});

test("today's daily candle and merging", () => {
  const bars: MinuteBar[] = [{ t: OCT5.open, o: 10, h: 11, l: 9, c: 10.5, v: 5 }, { t: OCT5.open + 60000, o: 10.5, h: 12, l: 10, c: 11, v: 7 }];
  assert.deepEqual(dayCandle(bars, OCT5), { o: 10, h: 12, l: 9, c: 11, v: 12 });
  assert.equal(dayCandle(bars, OCT2), null);
  const merged = mergeBars(bars, [{ ...bars[0]!, c: 9.5 }, { t: OCT5.open + 120000, o: 11, h: 11, l: 11, c: 11, v: 0 }]);
  assert.deepEqual(merged.map(b => [b.t - OCT5.open, b.c]), [[0, 9.5], [60000, 11], [120000, 11]]);
});

test("minute reads stay within the span Robinhood is known to answer", () => {
  const week = sessionsThrough("2026-10-02", 5);
  assert.deepEqual(week.map(s => s.date), ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"]);
  assert.equal(minuteWindows(week).length, 1);
  // Across a weekend and a holiday (Labor Day, 2026-09-07): split, and no window longer than the cap.
  const ten = sessionsThrough("2026-09-11", 10);
  assert.ok(!ten.some(s => s.date === "2026-09-07"));
  const windows = minuteWindows(ten);
  assert.ok(windows.length >= 2 && windows.every(w => w.end - w.start <= MAX_MINUTE_WINDOW_MS));
  assert.equal(windows[0]!.start, ten[0]!.open); assert.equal(windows.at(-1)!.end, ten.at(-1)!.close);
});

test("store: official replaces provisional, never the reverse, and history survives a reopen", t => {
  const dir = mkdtempSync(join(tmpdir(), "astra-chart-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "nested", "charts.sqlite");
  const store = new ChartStore(path);
  const m = OCT5.open + min(10);
  assert.deepEqual(store.putTick("RDDT", m, 150, m + 1000), { t: m, o: 150, h: 150, l: 150, c: 150, v: 0 });
  assert.deepEqual(store.putTick("RDDT", m, 151, m + 3000), { t: m, o: 150, h: 151, l: 150, c: 151, v: 0 });
  // An older trade arriving late widens the range but does not move the close back.
  assert.deepEqual(store.putTick("RDDT", m, 149, m + 2000), { t: m, o: 150, h: 151, l: 149, c: 151, v: 0 });
  store.putTick("RDDT", m + min(1), 152, m + min(1));                    // a minute Robinhood will say had no trade
  store.putTick("RDDT", m + min(5), 153, m + min(5));                    // still forming, outside the settled window
  store.putOfficial("RDDT", OCT5.open, m + min(5), [{ t: m, o: 150.1, h: 151.2, l: 148.9, c: 151, v: 900 }]);
  assert.deepEqual(store.bars("RDDT", 0, Number.MAX_SAFE_INTEGER).map(b => [b.t - m, b.v]), [[0, 900], [min(5), 0]]);
  assert.equal(store.putTick("RDDT", m, 999, m + 9000), null, "a quote cannot change an official minute");
  assert.equal(store.officialCount("RDDT", OCT5.open, OCT5.close), 1);
  assert.equal(store.officialCount("QCOM", OCT5.open, OCT5.close), 0);
  store.close();
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const reopened = new ChartStore(path); t.after(() => reopened.close());
  assert.equal(reopened.bars("RDDT", 0, Number.MAX_SAFE_INTEGER).length, 2);
  reopened.prune(m + 1);
  assert.deepEqual(reopened.bars("RDDT", 0, Number.MAX_SAFE_INTEGER).map(b => b.t - m), [min(5)]);
});

test("chart settings are validated, with defaults", () => {
  assert.deepEqual(chartSettingsSchema.parse({}), { pollSeconds: 2, refreshSeconds: 60, backfillSessions: 5, retentionDays: 90, maxSymbols: 10, staleSeconds: 15 });
  assert.throws(() => chartSettingsSchema.parse({ pollSeconds: 0.1 }));
  assert.throws(() => chartSettingsSchema.parse({ maxSymbols: 21 }));
  assert.throws(() => chartSettingsSchema.parse({ surprise: 1 }));
});

// ---- the poll loop, with a fake Robinhood and a hand-set clock ----
function quote(symbol: string, price: number | null, tradeAt: string, regularSession = true): EquityMarketQuote {
  return { symbol, price, tradeAt, retrievedAt: tradeAt, ageMs: 0, fresh: true, regularSession, state: "active", bid: null, ask: null };
}
function minuteReply(symbol: string, bars: { t: number; c: number }[]) {
  return { data: { results: [{ symbol, interval: "minute", bounds: "regular", bars: bars.map(b => ({ begins_at: new Date(b.t).toISOString(),
    open_price: String(b.c), high_price: String(b.c), low_price: String(b.c), close_price: String(b.c), volume: 100, session: "reg" })) }] } };
}
function harness(t: import("node:test").TestContext, now: number) {
  const clock = { now };
  const reads: { kind: string; symbols?: string[]; symbol?: string; start?: number; end?: number }[] = [];
  let quotes: EquityMarketQuote[] = [], failQuotes = false;
  const source: ChartSource = {
    async quotes(symbols) { reads.push({ kind: "quotes", symbols }); if (failQuotes) throw new Error("down"); return quotes.filter(q => symbols.includes(q.symbol)); },
    async minuteBars(symbol, start, end) {
      reads.push({ kind: "bars", symbol, start, end });
      // Regular bounds, as Robinhood answers them: session minutes only, nothing overnight or at weekends.
      const sessions = sessionsThrough("2026-10-09", 30);
      const bars = []; for (let m = start; m < end; m += 60000) if (bucketStart(m, 1, sessions) !== null) bars.push({ t: m, c: 100 + (m - start) / 60000 / 100 });
      return minuteReply(symbol, bars);
    },
  };
  const store = new ChartStore(":memory:");
  const live = new LiveCharts(store, source, {}, () => clock.now);
  t.after(() => { live.close(); store.close(); });
  return { clock, reads, store, live, setQuotes: (q: EquityMarketQuote[]) => { quotes = q; }, failQuotes: (v: boolean) => { failQuotes = v; } };
}

test("history: backfills missing sessions in short reads once, then serves them from the store", async t => {
  const h = harness(t, OCT5.open + min(45));                              // Monday 10:15 ET
  const first = await h.live.history("RDDT");
  const backfill = h.reads.filter(r => r.kind === "bars" && r.start! < OCT5.open);
  assert.ok(backfill.length >= 1 && backfill.every(r => r.end! - r.start! <= MAX_MINUTE_WINDOW_MS));
  // Five settled sessions before today (Sep 28 - Oct 2), each 390 minutes, plus today's minutes that ended at least
  // a minute ago: 9:30 through 10:13 at 10:15.
  assert.equal(first.bars.filter(b => b.t < OCT5.open).length, 5 * 390);
  assert.equal(first.bars.filter(b => b.t >= OCT5.open).length, 44);
  assert.deepEqual(first.sessions.map(s => s.date), ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-05"]);
  assert.equal(first.today?.date, "2026-10-05"); assert.deepEqual(first.warnings, []);
  h.reads.length = 0;
  await h.live.history("RDDT");
  assert.deepEqual(h.reads.map(r => r.kind), ["bars"], "a reload re-reads today only");
  assert.equal(h.reads[0]!.start, OCT5.open);
});

test("history on a weekend: nothing live, no read for today, stored history still served", async t => {
  const h = harness(t, Date.parse("2026-10-04T16:00:00Z"));               // Sunday
  const result = await h.live.history("RDDT");
  assert.equal(result.today, null);
  assert.ok(h.reads.every(r => r.end! <= OCT2.close));
  assert.equal(result.bars.length, 5 * 390);
});

test("polling: one quote read for every charted symbol; only today's regular-session trades move a candle", async t => {
  const h = harness(t, OCT5.open + min(20) + 5000);
  const events: Record<string, ChartEvent[]> = { RDDT: [], QCOM: [] };
  h.live.subscribe("RDDT", e => events.RDDT!.push(e));
  h.live.subscribe("QCOM", e => events.QCOM!.push(e));
  assert.deepEqual(events.RDDT!.map(e => e.type), ["status"]);
  const tick = new Date(OCT5.open + min(20) + 2000).toISOString();
  h.setQuotes([quote("RDDT", 150.25, tick), quote("QCOM", 185, new Date(OCT2.close - 1000).toISOString())]);
  await h.live.pollOnce();
  assert.deepEqual(h.reads.map(r => [r.kind, r.symbols]), [["quotes", ["RDDT", "QCOM"]]]);
  const bar = events.RDDT!.find(e => e.type === "bar");
  assert.deepEqual(bar, { type: "bar", bar: { t: OCT5.open + min(20), o: 150.25, h: 150.25, l: 150.25, c: 150.25, v: 0 }, price: 150.25, tradeAt: tick });
  assert.ok(!events.QCOM!.some(e => e.type === "bar"), "Friday's last trade is not drawn into Monday's candle");
  assert.deepEqual(events.RDDT!.filter(e => e.type === "status").map(e => (e as any).state), ["connecting", "live"]);
  // After-hours print during the session clock (e.g. a stale extended-hours flag): ignored.
  h.setQuotes([quote("RDDT", 151, tick, false)]);
  const before = events.RDDT!.length; await h.live.pollOnce();
  assert.equal(events.RDDT!.length, before);
});

test("polling: a captured after-hours Robinhood quote never moves a session candle", async t => {
  // RDDT and QCOM as Robinhood returned them on 2026-10-02 after the close: the newest trade is an after-hours one.
  const raw = JSON.parse(readFileSync("test/fixtures/robinhood-quotes.json", "utf8"));
  const quotes = normalizeMarketQuotes(raw, ["RDDT", "QCOM"], Date.parse("2026-10-02T19:59:58Z"));
  assert.ok(quotes.every(q => q.regularSession === false && q.price !== null));
  const h = harness(t, Date.parse("2026-10-02T19:59:58Z"));               // inside Friday's session by the clock
  const events: ChartEvent[] = [];
  h.live.subscribe("RDDT", e => events.push(e));
  h.setQuotes(quotes);
  await h.live.pollOnce();
  assert.ok(!events.some(e => e.type === "bar"));
  assert.equal(h.store.bars("RDDT", 0, Number.MAX_SAFE_INTEGER).length, 0);
});

test("polling: closed market reads nothing; failures turn into 'stale' after the grace period", async t => {
  const h = harness(t, OCT5.open - min(10));
  const events: ChartEvent[] = [];
  h.live.subscribe("RDDT", e => events.push(e));
  await h.live.pollOnce();
  assert.equal(h.reads.length, 0);
  assert.deepEqual(events.map(e => (e as any).state), ["closed"]);
  h.clock.now = OCT5.open + min(1);
  h.setQuotes([quote("RDDT", 150, new Date(OCT5.open + 30000).toISOString())]);
  await h.live.pollOnce();
  assert.equal(events.at(-1)!.type === "status" && events.at(-1)!.type, "status");
  assert.deepEqual(events.filter(e => e.type === "status").map(e => (e as any).state), ["closed", "live"]);
  h.failQuotes(true);
  h.clock.now += 10000; await h.live.pollOnce();
  assert.deepEqual(events.filter(e => e.type === "status").map(e => (e as any).state), ["closed", "live"], "still inside staleSeconds");
  h.clock.now += 10000; await h.live.pollOnce();
  assert.deepEqual(events.filter(e => e.type === "status").map(e => (e as any).state), ["closed", "live", "stale"]);
});

test("refresh: minutes ended a minute ago become official; newer ones stay with the quotes", async t => {
  const now = OCT5.open + min(3) + 20000;                                  // 9:33:20 ET
  const h = harness(t, now);
  const events: ChartEvent[] = [];
  h.live.subscribe("RDDT", e => events.push(e));
  // 9:32 ended 20 s ago: Robinhood may not have published its bar yet, so its provisional bar must survive.
  h.store.putTick("RDDT", OCT5.open + min(2), 120, OCT5.open + min(2) + 5000);
  h.store.putTick("RDDT", OCT5.open + min(3), 121, now - 1000);
  await h.live.refreshOnce();
  const sent = events.find(e => e.type === "bars") as Extract<ChartEvent, { type: "bars" }>;
  assert.equal(sent.from, OCT5.open); assert.equal(sent.to, OCT5.close);
  assert.deepEqual(sent.bars.map(b => [b.t - OCT5.open, b.v]), [[0, 100], [min(1), 100], [min(2), 0], [min(3), 0]]);
  assert.equal(h.store.officialCount("RDDT", OCT5.open, OCT5.close), 2);
  assert.equal(h.store.isComplete("RDDT", "2026-10-05"), false);
  // Read three minutes after the close: every minute settles and the session is recorded as complete.
  h.clock.now = OCT5.close + min(2) + 1000;
  await h.live.refreshOnce();
  assert.equal(h.store.officialCount("RDDT", OCT5.open, OCT5.close), 390);
  assert.equal(h.store.isComplete("RDDT", "2026-10-05"), true);
});

test("a session stored only in part is read again in full", async t => {
  // Friday: charted 9:30-11:00 and closed, so the store holds the morning only.
  const h = harness(t, OCT2.open + min(91));
  await h.live.history("RDDT");
  assert.equal(h.store.bars("RDDT", OCT2.open, OCT2.close).length, 90);                // 9:30-10:59, read at 11:01
  assert.equal(h.store.isComplete("RDDT", "2026-10-02"), false);
  // Monday: Friday is re-read, and now complete; the sessions completed by Friday's backfill are not.
  h.clock.now = OCT5.open + min(5); h.reads.length = 0;
  await h.live.history("RDDT");
  const backfill = h.reads.filter(r => r.kind === "bars" && r.start! < OCT5.open);
  assert.deepEqual(backfill.map(r => [r.start, r.end]), [[OCT2.open, OCT2.close]]);
  assert.equal(h.store.bars("RDDT", OCT2.open, OCT2.close).length, 390);
  assert.equal(h.store.isComplete("RDDT", "2026-10-02"), true);
});

test("one ticker Robinhood will not quote leaves the batch; its pages see stale, then a reason, never a false Live", async t => {
  const h = harness(t, OCT5.open + min(20));
  const tick = new Date(OCT5.open + min(20) - 1000).toISOString();
  // Like Robinhood: the batch is refused whole when one symbol is unknown.
  let reads = 0;
  const live = new LiveCharts(h.store, {
    quotes: async symbols => { reads++; if (symbols.includes("RDDTT")) throw new Error("Incomplete or mismatched quote batch"); return symbols.map(s => quote(s, 150, tick)); },
    minuteBars: async () => minuteReply("RDDT", []),
  }, {}, () => h.clock.now);
  t.after(() => live.close());
  const good: ChartEvent[] = [], bad: ChartEvent[] = [];
  live.subscribe("RDDT", e => good.push(e)); live.subscribe("RDDTT", e => bad.push(e));
  await live.pollOnce();
  assert.ok(good.some(e => e.type === "bar"), "the good symbol still ticks on the poll that found the bad one");
  assert.deepEqual(bad.map(e => e.type === "status" ? e.state : e.type), ["connecting", "stale"], "stale at first, not yet blamed");
  reads = 0; h.clock.now += 2000; await live.pollOnce();
  assert.equal(reads, 1, "later polls are one batch again, without the bad symbol");
  assert.equal((good.filter(e => e.type === "status").at(-1) as any).state, "live");
  await live.refreshOnce();                                                 // its own retry fails too: now a reason
  assert.deepEqual(bad.at(-1), { type: "error", message: "Robinhood has no live quote for RDDTT right now. Retrying every 60 s; check the ticker if this stays." });
  // A second page for it, opened now, is told the same, not the shared "live".
  const late: ChartEvent[] = []; live.subscribe("RDDTT", e => late.push(e));
  assert.equal(late[0]!.type, "error");
  // The close is true for every symbol, refused or not.
  h.clock.now = OCT5.close + 1000; await live.pollOnce();
  assert.deepEqual(bad.at(-1), { type: "status", state: "closed", lastQuoteAt: tick });
});

test("a refused batch is broken up at most every 30 s, so a rate limit is not met with more reads", async t => {
  const h = harness(t, OCT5.open + min(20));
  let reads = 0;
  const live = new LiveCharts(h.store, { quotes: async symbols => {
    reads++; if (symbols.length > 1 || symbols[0] === "QCOM") throw new Error("429"); return symbols.map(s => quote(s, 150, new Date(h.clock.now - 500).toISOString()));
  }, minuteBars: async () => minuteReply("RDDT", []) }, {}, () => h.clock.now);
  t.after(() => live.close());
  for (const s of ["RDDT", "QCOM", "HPE"]) live.subscribe(s, () => {});
  await live.pollOnce();
  assert.equal(reads, 4, "the batch, then each of three once");
  reads = 0; h.clock.now += 2000; await live.pollOnce();
  assert.equal(reads, 1, "QCOM left out: the remaining batch of two is refused, and is not broken up again yet");
  reads = 0; h.clock.now += 30000; await live.pollOnce();
  assert.equal(reads, 3);
});

test("a good ticker that fails once is left out only until it answers again", async t => {
  const h = harness(t, OCT5.open + min(20));
  const tick = new Date(OCT5.open + min(20) - 1000).toISOString();
  let blip = true;
  const live = new LiveCharts(h.store, {
    quotes: async symbols => {
      if (symbols.length > 1 && blip) throw new Error("timeout");              // the batch hits a passing error
      if (symbols[0] === "RDDT" && blip) { blip = false; throw new Error("timeout"); }  // and RDDT's own retry once more
      return symbols.map(s => quote(s, 150, tick));
    },
    minuteBars: async () => minuteReply("RDDT", []),
  }, {}, () => h.clock.now);
  t.after(() => live.close());
  const events: ChartEvent[] = [];
  live.subscribe("RDDT", e => events.push(e)); live.subscribe("QCOM", () => {});
  await live.pollOnce();
  assert.equal(events.filter(e => e.type === "error").length, 0, "one failure is not a verdict");
  assert.equal((events.filter(e => e.type === "status").at(-1) as any).state, "stale");
  assert.ok(!events.some(e => e.type === "bar"), "left out of the poll that failed");
  await live.refreshOnce();                                                 // the retry: RDDT answers, and rejoins
  const since = events.length;
  h.clock.now += 2000; await live.pollOnce();
  assert.ok(events.slice(since).some(e => e.type === "bar"), "RDDT ticks again after rejoining");
  assert.equal((events.filter(e => e.type === "status").at(-1) as any).state, "live", "and its page is told it is live");
});

test("an outage blames no ticker and does not multiply reads", async t => {
  const h = harness(t, OCT5.open + min(20));
  let reads = 0;
  const live = new LiveCharts(h.store, { quotes: async () => { reads++; throw new Error("down"); }, minuteBars: async () => ({}) }, {}, () => h.clock.now);
  t.after(() => live.close());
  const events: ChartEvent[] = [];
  live.subscribe("RDDT", e => events.push(e)); live.subscribe("QCOM", () => {});
  await live.pollOnce();
  assert.equal(reads, 3, "the batch, then each symbol once");
  assert.ok(!events.some(e => e.type === "error"));
  reads = 0; h.clock.now += 2000; await live.pollOnce();
  assert.equal(reads, 1, "no second fallback within 30 s");
});

test("a quote read that hangs turns pages stale on time", async t => {
  const h = harness(t, OCT5.open + min(20));
  let release!: () => void;
  const live = new LiveCharts(h.store, {
    quotes: symbols => new Promise(ok => { release = () => ok(symbols.map(s => quote(s, 150, new Date(OCT5.open + min(20)).toISOString()))); }),
    minuteBars: async () => ({}),
  }, {}, () => h.clock.now);
  t.after(() => live.close());
  const states: string[] = [];
  live.subscribe("RDDT", e => { if (e.type === "status") states.push(e.state); });
  const first = live.pollOnce();
  h.clock.now += 16000; await live.pollOnce();                            // the first read is still outstanding
  assert.deepEqual(states, ["connecting", "stale"]);
  release(); await first;
  assert.deepEqual(states, ["connecting", "stale", "live"]);
});

test("an empty reply for a past session is read again later, not recorded as complete", async t => {
  const h = harness(t, OCT5.open - min(30));
  let empty = true;
  const live = new LiveCharts(h.store, { quotes: async () => [], minuteBars: async (symbol, start, end) => {
    if (empty) return minuteReply(symbol, []);
    const bars = []; for (let m = start; m < end; m += 60000) if (bucketStart(m, 1, sessionsThrough("2026-10-09", 30)) !== null) bars.push({ t: m, c: 100 });
    return minuteReply(symbol, bars);
  } }, {}, () => h.clock.now);
  t.after(() => live.close());
  await live.history("RDDT");
  assert.equal(h.store.isComplete("RDDT", "2026-10-02"), false);
  empty = false;
  await live.history("RDDT");
  assert.equal(h.store.isComplete("RDDT", "2026-10-02"), true);
});

test("reads never span a session already held, and a completed today is not re-read", async t => {
  const week = sessionsThrough("2026-10-02", 5);
  assert.deepEqual(minuteWindows([week[0]!, week[4]!], week).length, 2, "Monday and Friday missing: two reads, not one over the held days");
  assert.equal(minuteWindows([week[1]!, week[2]!], week).length, 1);
  const h = harness(t, OCT5.close + min(5));
  await h.live.history("RDDT");
  await h.live.refreshOnce();                                               // no listeners: nothing
  h.store.markComplete("RDDT", "2026-10-05", OCT5.close);
  h.reads.length = 0;
  await h.live.history("RDDT");
  assert.deepEqual(h.reads, []);
});

test("a page open overnight is 'connecting' at the open, not stale from yesterday", async t => {
  const h = harness(t, OCT2.close + min(60));                              // Friday evening: the loop starts idle
  const live = new LiveCharts(h.store, { quotes: () => new Promise(() => {}), minuteBars: async () => ({}) }, {}, () => h.clock.now);
  t.after(() => live.close());
  const states: string[] = [];
  live.subscribe("RDDT", e => { if (e.type === "status") states.push(e.state); });
  h.clock.now = OCT5.open + 2000; void live.pollOnce();                    // Monday's first read, still outstanding
  h.clock.now = OCT5.open + 10000; await live.pollOnce();
  assert.deepEqual(states, ["closed", "connecting"], "ten seconds into the session, not a weekend of waiting");
  h.clock.now = OCT5.open + 16000; await live.pollOnce();
  assert.deepEqual(states, ["closed", "connecting", "stale"]);
});

test("a page opened after the last one closed starts as connecting, not stale", async t => {
  const h = harness(t, OCT5.open + min(20));
  h.setQuotes([quote("RDDT", 150, new Date(OCT5.open + min(20)).toISOString())]);
  const off = h.live.subscribe("RDDT", () => {});
  await h.live.pollOnce(); off();
  h.clock.now += min(10);
  const states: string[] = [];
  h.live.subscribe("RDDT", e => { if (e.type === "status") states.push(e.state); });
  assert.deepEqual(states, ["connecting"]);
});

test("subscriptions: capped, and the loop stops when the last page leaves", async t => {
  const h = harness(t, OCT5.open + min(5));
  const live = new LiveCharts(h.store, { quotes: async () => [], minuteBars: async () => ({}) }, { maxSymbols: 2 }, () => h.clock.now);
  t.after(() => live.close());
  const offA = live.subscribe("AAA", () => {}), offB = live.subscribe("BBB", () => {});
  assert.throws(() => live.subscribe("CCC", () => {}), /At most 2 symbols/);
  const offA2 = live.subscribe("AAA", () => {});                          // a second tab on a charted symbol is free
  offA(); offA2(); offB();
  assert.deepEqual(live.symbols, []);
  assert.doesNotThrow(() => live.subscribe("CCC", () => {}));
});

// ---- the loopback server ----
function get(url: string, headers: Record<string, string> = {}, method = "GET"): Promise<{ status: number; headers: Record<string, any>; body: string }> {
  return new Promise((ok, fail) => {
    const req = request(url, { method, headers }, res => {
      let body = ""; res.setEncoding("utf8");
      res.on("data", c => { body += c; if (res.headers["content-type"]?.startsWith("text/event-stream") && body.includes('"bar"')) { req.destroy(); ok({ status: res.statusCode!, headers: res.headers, body }); } });
      res.on("end", () => ok({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on("error", fail); req.end();
  });
}

test("chart server: page, data and stream behind a random path; other origins and hosts refused", async t => {
  let unsubscribed = 0;
  const server = new ChartServer({
    daily: async symbol => ({ symbol, candles: [] }),
    intraday: async symbol => ({ symbol, bars: [], sessions: [], today: null, warnings: [] }),
    subscribe: (symbol, listener) => {
      listener({ type: "status", state: "live", lastQuoteAt: null });
      const timer = setTimeout(() => listener({ type: "bar", bar: { t: 0, o: 1, h: 1, l: 1, c: 1, v: 0 }, price: 1, tradeAt: "x" }), 20);
      return () => { clearTimeout(timer); unsubscribed++; };
    },
  });
  t.after(() => server.close());
  const url = await server.url("RDDT");
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/chart\/[A-Za-z0-9_-]{24}\?symbol=RDDT$/);
  const page = url.replace(/\?.*/, ""), origin = new URL(url).origin;

  const html = await get(url);
  assert.equal(html.status, 200);
  const csp = html.headers["content-security-policy"] as string;
  assert.match(csp, /default-src 'none'; script-src 'sha256-[A-Za-z0-9+/=]+'/);
  assert.match(csp, /connect-src 'self'/); assert.match(csp, /frame-ancestors 'none'/);
  assert.ok(!/https?:\/\/(?!www\.tradingview\.com)/.test(html.body.replace(/<script>[\s\S]*<\/script>/, "")), "nothing loads from the network");
  assert.match(html.body, /TradingView Lightweight Charts/);

  assert.deepEqual(JSON.parse((await get(`${page}/api/daily?symbol=RDDT`)).body), { symbol: "RDDT", candles: [] });
  assert.equal((await get(`${page}/api/daily?symbol=RDDT`, { origin })).status, 200, "the page's own origin is fine");
  assert.equal((await get(`${page}/api/daily?symbol=rddt`)).status, 400);
  assert.equal((await get(`${page}/api/daily?symbol=RDDT`, { origin: "http://evil.example" })).status, 403);
  assert.equal((await get(`${page}/api/daily?symbol=RDDT`, { origin: "null" })).status, 403);
  assert.equal((await get(`${page}/api/daily?symbol=RDDT`, { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await get(`${page}/api/daily?symbol=RDDT`, { "sec-fetch-site": "same-site" })).status, 403, "another loopback port is same-site");
  assert.equal((await get(`${page}/api/daily?symbol=RDDT`, { host: "attacker.test" })).status, 403);
  assert.equal((await get(`${page}/api/daily?symbol=RDDT`, {}, "POST")).status, 403);
  const wrong = page.replace(/\/chart\/[^/]+/, "/chart/AAAAAAAAAAAAAAAAAAAAAAAA");
  assert.equal((await get(`${wrong}/api/daily?symbol=RDDT`)).status, 404);
  assert.equal((await get(`${page}/api/nope?symbol=RDDT`)).status, 404);

  const stream = await get(`${page}/api/stream?symbol=RDDT`);
  assert.match(stream.headers["content-type"], /^text\/event-stream/);
  const events = stream.body.split("\n\n").filter(l => l.startsWith("data: ")).map(l => JSON.parse(l.slice(6)).type);
  assert.deepEqual(events, ["status", "bar"]);
  await new Promise(ok => setTimeout(ok, 50));
  assert.equal(unsubscribed, 1, "a closed tab stops costing reads");
});

test("chart server: a malformed request line is answered, and the process lives", async t => {
  const server = new ChartServer({ daily: async () => ({}), intraday: async () => ({ symbol: "X", bars: [], sessions: [], today: null, warnings: [] }), subscribe: () => () => {} });
  t.after(() => server.close());
  const url = new URL(await server.url());
  const { connect } = await import("node:net");
  const reply = await new Promise<string>((ok, fail) => {
    const socket = connect(Number(url.port), "127.0.0.1", () => socket.write(`GET http://[ HTTP/1.1\r\nHost: 127.0.0.1:${url.port}\r\n\r\n`));
    let data = ""; socket.on("data", c => { data += c; }); socket.on("end", () => ok(data)); socket.on("error", fail);
    setTimeout(() => { socket.destroy(); ok(data); }, 500);
  });
  assert.match(reply, /^HTTP\/1\.1 400/);
  assert.equal((await get(`${url.origin}${url.pathname}/api/daily?symbol=RDDT`)).status, 200, "still serving");
});

test("chart server: close() during a bind leaves nothing listening", async () => {
  const server = new ChartServer({ daily: async () => ({}), intraday: async () => ({ symbol: "X", bars: [], sessions: [], today: null, warnings: [] }), subscribe: () => () => {} });
  const pending = server.url();
  await server.close();
  const url = new URL(await pending);
  await assert.rejects(get(`${url.origin}/`), /ECONNREFUSED/);
});

test("chart server: a subscription refused is reported on the stream, which then ends", async t => {
  const server = new ChartServer({ daily: async () => ({}), intraday: async () => ({ symbol: "X", bars: [], sessions: [], today: null, warnings: [] }),
    subscribe: () => { throw new Error("At most 10 symbols can be charted live at once; close a chart first."); } });
  t.after(() => server.close());
  const page = (await server.url()).replace(/\?.*/, "");
  const stream = await get(`${page}/api/stream?symbol=RDDT`);
  assert.match(stream.body, /"type":"error","final":true,"message":"At most 10 symbols/);
});
