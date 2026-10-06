import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { chromium, firefox, webkit, type Browser, type BrowserType } from "playwright-core";
import { ChartServer } from "../../src/chart-server.ts";
import { sessionsThrough, type MinuteBar } from "../../src/intraday-bars.ts";
import type { ChartListener } from "../../src/live-chart.ts";

// Real browsers: the page runs under a hash-pinned CSP, and only a browser enforces it. A missing browser FAILS with
// the install command; this suite never skips.
const installHint = `npx playwright-core install${process.platform === "linux" ? " --with-deps" : ""} --only-shell chromium webkit firefox`;
async function launch(type: BrowserType, t: TestContext): Promise<Browser> {
  let browser: Browser;
  try { browser = await type.launch({ headless: true }); }
  catch (error) { throw new Error(`${type.name()} failed to launch for playwright-core. If it isn't installed, run: ${installHint}`, { cause: error }); }
  t.after(() => browser.close());
  return browser;
}

// Invented prices on real session times: two full sessions of minutes, then Monday's first hour.
const sessions = sessionsThrough("2026-10-05", 3);
const today = sessions.at(-1)!;
function minutes(): MinuteBar[] {
  const out: MinuteBar[] = [];
  let price = 100;
  for (const s of sessions) {
    const end = s === today ? s.open + 60 * 60000 : s.close;
    for (let t = s.open; t < end; t += 60000) { const o = price; price += Math.sin(t / 7e5) * 0.05; out.push({ t, o, h: Math.max(o, price) + 0.03, l: Math.min(o, price) - 0.03, c: price, v: 100 }); }
  }
  return out;
}
function daily() {
  const candles = [];
  let price = 80;
  for (let d = Date.parse("2024-01-02T00:00:00Z"); d <= Date.parse("2026-10-02T00:00:00Z"); d += 86400000) {
    const day = new Date(d).getUTCDay(); if (day === 0 || day === 6) continue;
    const o = price; price += Math.sin(d / 5e9) * 0.4;
    candles.push({ time: new Date(d).toISOString().slice(0, 10), open: o, high: Math.max(o, price) + 0.5, low: Math.min(o, price) - 0.5, close: price });
  }
  const zone = (lo: number, hi: number) => ({ id: `z${lo}`, lo, hi, tests: 4, last: "2026-09-01", members: [] });
  const frame = (timeframe: string, label: string, start: string, bar = "day") => ({ timeframe, label, start, sessions: 60, bar, sinceListing: false,
    resistance: [zone(104, 105)], support: [zone(95, 96)], gaps: [], trend: {} });
  return { symbol: "DEMOA", asOf: "2026-10-02", price, priceSource: "close", priceAt: null, defaultTimeframe: "ytd", warnings: [],
    frames: [frame("qtd", "Quarter to date", "2026-10-01"), frame("ytd", "Year to date", "2026-01-02"), frame("2y", "Two years", "2024-10-02"),
      frame("5y", "Five years", "2024-01-02", "week")],
    candles, sma: { 10: candles.slice(9).map(c => ({ time: c.time, value: c.close })) } };
}

for (const type of [chromium, webkit, firefox]) {
  test(`${type.name()}: two panels draw, zoom by wheel and buttons, switch candle size, and take a live tick`, async t => {
    const listeners = new Set<ChartListener>();
    const loads: string[] = [], subscribed: string[] = [];
    // DEMOB is a ticker Robinhood does not know: no daily history and no minute bars.
    const server = new ChartServer({
      daily: async symbol => symbol === "DEMOB" ? { symbol, unavailable: "no usable daily price history from Robinhood" } : daily(),
      // DEMOC's intraday read fails outright, so its page never learns today's session.
      intraday: async symbol => { loads.push(symbol); if (symbol === "DEMOC") throw new Error("read failed"); return { symbol, bars: symbol === "DEMOB" ? [] : minutes(), sessions, today, warnings: [] }; },
      subscribe: (symbol, listener) => { subscribed.push(symbol); listeners.add(listener); listener({ type: "status", state: "live", lastQuoteAt: null }); return () => listeners.delete(listener); },
    });
    t.after(() => server.close());
    const browser = await launch(type, t);
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    const problems: string[] = [];
    page.on("console", m => { if (m.type() === "error") problems.push(m.text()); });
    page.on("pageerror", e => problems.push(e.message));
    await page.addInitScript(() => document.addEventListener("securitypolicyviolation", e =>
      console.error(`CSP blocked ${e.violatedDirective}: ${e.blockedURI}`)));

    await page.goto(await server.url("DEMOA"));
    const chart = <T>(fn: string) => page.evaluate(`window.__astraChart.${fn}()`) as Promise<T>;
    // Views apply on the chart's next frames; a range is read once they have.
    const range = async (which: "intradayRange" | "dailyRange") => { await chart("settled"); return chart<{ from: number; to: number }>(which); };
    await page.waitForFunction(() => (window as any).__astraChart?.intradayCount() > 0);
    // 1-minute: two full sessions (390 each) plus Monday's first 60 minutes.
    assert.equal(await chart<number>("intradayCount"), 390 * 2 + 60);
    await page.waitForFunction(() => (window as any).__astraChart.dailyLast());
    assert.equal(((await chart<any>("dailyLast")).time), "2026-10-05", "today's daily candle is built from its minutes");
    assert.match(await page.textContent("#status") ?? "", /^Live/);

    // Candle size: 30-minute candles, 13 per full session and 2 for Monday's first hour.
    await page.click('#intervals button[data-value="30"]');
    assert.equal(await chart<number>("intradayCount"), 13 * 2 + 2);
    assert.equal(await page.getAttribute('#intervals button[data-value="30"]', "aria-pressed"), "true");
    await page.click('#intervals button[data-value="1"]');

    // Zoom: the wheel over the intraday chart narrows the visible range; the buttons widen and narrow it; Reset
    // returns to the latest session.
    const width = (r: { from: number; to: number }) => r.to - r.from;
    const start = width(await range("intradayRange"));
    // Opens on the latest session with bars: Monday's first hour, not out to a 4 pm that has not happened.
    assert.ok(start > 55 && start < 75, `opening view spans ${start} bars`);
    const box = (await page.locator("#intraday").boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 3; i++) await page.mouse.wheel(0, -200);
    await page.waitForFunction(w => { const r = (window as any).__astraChart.intradayRange(); return r.to - r.from < w; }, start);
    const zoomedIn = width(await range("intradayRange"));
    await page.click('#intraday-panel [data-zoom="out"]');
    assert.ok(width(await range("intradayRange")) > zoomedIn);
    await page.click('#intraday-panel [data-zoom="in"]'); await page.click('#intraday-panel [data-zoom="in"]');
    assert.ok(width(await range("intradayRange")) < zoomedIn);
    await page.click('#intraday-panel [data-zoom="reset"]');
    assert.ok(Math.abs(width(await range("intradayRange")) - start) < 5);

    // Daily timeframes: 2Y shows more sessions than QTD; the daily zoom buttons work too.
    await page.click('#frames button[data-value="qtd"]');
    const qtd = width(await range("dailyRange"));
    await page.click('#frames button[data-value="2y"]');
    assert.ok(width(await range("dailyRange")) > qtd * 5);
    await page.click('#daily-panel [data-zoom="in"]');
    assert.ok(width(await range("dailyRange")) < width({ from: 0, to: 500 }) * 2);

    // A live tick in Monday's 61st minute: a new 1-minute candle, and today's daily candle closes at its price.
    const tickAt = today.open + 60 * 60000;
    for (const listener of listeners) listener({ type: "bar", bar: { t: tickAt, o: 123.45, h: 123.45, l: 123.45, c: 123.45, v: 0 },
      price: 123.45, tradeAt: new Date(tickAt + 1000).toISOString() });
    await page.waitForFunction(() => (window as any).__astraChart.intradayLast().close === 123.45);
    assert.equal(await chart<number>("intradayCount"), 390 * 2 + 61);
    assert.equal((await chart<any>("dailyLast")).close, 123.45);
    assert.match(await page.textContent("#price") ?? "", /DEMOA \$123\.45/);

    // A tick for an older minute than the newest (quote time went backwards) redraws rather than throwing.
    const pushBar = (t: number, c: number) => { for (const listener of listeners) listener({ type: "bar", bar: { t, o: c, h: c, l: c, c, v: 0 }, price: c, tradeAt: new Date(t).toISOString() }); };
    pushBar(today.open + 30 * 60000, 99.99);
    await page.waitForFunction(() => /\$99\.99/.test(document.getElementById("price")!.textContent ?? ""));
    assert.equal(await chart<number>("intradayCount"), 390 * 2 + 61);

    // An error that is not final keeps the stream: the reason shows, and a later status brings the page back.
    for (const listener of listeners) listener({ type: "error", message: "Robinhood has no live quote for DEMOA right now." });
    await page.waitForFunction(() => /no live quote/.test(document.getElementById("status")!.textContent ?? ""));
    for (const listener of listeners) listener({ type: "status", state: "live", lastQuoteAt: null });
    await page.waitForFunction(() => /^Live/.test(document.getElementById("status")!.textContent ?? ""));

    // Stale prices are said, not hidden.
    for (const listener of listeners) listener({ type: "status", state: "stale", lastQuoteAt: new Date(tickAt).toISOString() });
    await page.waitForFunction(() => document.body.classList.contains("stale"));
    assert.match(await page.textContent("#status") ?? "", /^Prices stale/);

    // Robinhood's refresh is the server's whole state for today: a candle it dropped leaves the page too.
    const kept = minutes().filter(b => b.t >= today.open && b.t !== today.open + 10 * 60000);
    for (const listener of listeners) listener({ type: "bars", from: today.open, to: today.close, bars: kept });
    await page.waitForFunction(n => (window as any).__astraChart.intradayCount() === n, 390 * 2 + 59);

    // A bar from the next session: the page reloads and fetches that session, instead of ticking beside frozen charts.
    const before = loads.length;
    await Promise.all([page.waitForEvent("load"), (async () => {
      for (const listener of listeners) listener({ type: "bar", bar: { t: today.close + 86400000, o: 1, h: 1, l: 1, c: 1, v: 0 }, price: 1, tradeAt: new Date(today.close + 86400000).toISOString() });
    })()]);
    await page.waitForFunction(() => (window as any).__astraChart?.intradayCount() > 0);
    assert.equal(loads.length, before + 1);
    // A second automatic reload within a minute is held back, never a loop.
    pushBar(today.close + 86400000, 1);
    await page.waitForFunction(() => /Reloading in \d+ s/.test(document.getElementById("status")!.textContent ?? ""));
    await page.waitForTimeout(1000);
    assert.equal(loads.length, before + 1);

    // A page that never learned today's session (its intraday read failed) ignores bars instead of reloading on them.
    const blind = await browser.newPage();
    await blind.goto(await server.url("DEMOC"));
    await blind.waitForFunction(() => /Intraday bars unavailable/.test(document.getElementById("intraday-note")!.textContent ?? ""));
    const blindLoads = loads.length;
    pushBar(today.open + 61 * 60000, 2);
    await blind.waitForTimeout(1000);
    assert.equal(loads.length, blindLoads);
    assert.doesNotMatch(await blind.textContent("#status") ?? "", /Reloading/);
    await blind.close();

    // A page that saw the market closed reloads when the session opens (a fresh tab: reloads are rate-limited per tab).
    const fresh = await browser.newPage();
    await fresh.goto(await server.url("DEMOA"));
    await fresh.waitForFunction(() => (window as any).__astraChart?.intradayCount() > 0);
    const opened = loads.length;
    for (const listener of listeners) listener({ type: "status", state: "closed", lastQuoteAt: null });
    await fresh.waitForFunction(() => /Market closed/.test(document.getElementById("status")!.textContent ?? ""));
    await Promise.all([fresh.waitForEvent("load"), (async () => {
      for (const listener of listeners) listener({ type: "status", state: "connecting", lastQuoteAt: null });
    })()]);
    await fresh.waitForFunction(() => (window as any).__astraChart?.intradayCount() > 0);
    assert.ok(loads.length > opened);
    await fresh.close();

    // The ticker box charts another stock. One Robinhood does not know is said so, and never joins the live batch.
    await page.fill("#symbol", "demob");
    await Promise.all([page.waitForURL(/symbol=DEMOB$/), page.press("#symbol", "Enter")]);
    await page.waitForFunction(() => /No Robinhood data for DEMOB/.test(document.getElementById("status")!.textContent ?? ""));
    assert.ok(!subscribed.includes("DEMOB"));
    assert.deepEqual(problems, []);
  });
}
