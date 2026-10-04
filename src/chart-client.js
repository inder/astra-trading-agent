// The live chart page. Runs inside an IIFE after the chart library and chart-aggregate.js, whose functions
// (bucketStart, aggregate, dayCandle, mergeBars) are in scope.
const LWC = window.LightweightCharts;
const $ = id => document.getElementById(id);
const base = location.pathname.replace(/\/$/, "");
const params = new URLSearchParams(location.search);
const symbol = (params.get("symbol") || "").toUpperCase();
const INTERVALS = [1, 2, 5, 15, 30];
const FRAMES = [["qtd", "QTD"], ["ytd", "YTD"], ["2y", "2Y"], ["5y", "5Y"]];
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// Lightweight Charts draws timestamps in UTC. Shifting each minute by New York's offset at that instant makes the
// axis read Eastern time, which is the clock the session, the opening range and every other Astra page use.
const etParts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
function etSeconds(ms) {
  const p = Object.fromEntries(etParts.formatToParts(ms).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) / 1000;
}
const etClock = ms => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", second: "2-digit" }).format(ms) + " ET";
const money = v => v == null ? "" : `$${v.toFixed(2)}`;

function makeChart(el) {
  return LWC.createChart(el, {
    autoSize: true,
    layout: { background: { color: css("--panel") }, textColor: css("--muted"), fontFamily: css("--mono"), attributionLogo: true },
    grid: { vertLines: { color: css("--grid") }, horzLines: { color: css("--grid") } },
    rightPriceScale: { borderVisible: false },
    timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 4 },
    crosshair: { mode: LWC.CrosshairMode.Normal },
    // The wheel zooms (centred on the pointer); dragging pans. Shift-scroll is left to the browser.
    handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
    handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
  });
}
const candleStyle = () => ({ upColor: css("--up"), downColor: css("--down"), borderVisible: false,
  wickUpColor: css("--up"), wickDownColor: css("--down"), priceLineVisible: true });

function zoom(chart, factor) {
  const ts = chart.timeScale(), range = ts.getVisibleLogicalRange();
  if (!range) return;
  const mid = (range.from + range.to) / 2, half = Math.max(5, (range.to - range.from) * factor / 2);
  ts.setVisibleLogicalRange({ from: mid - half, to: mid + half });
}
function wireZoom(panel, chart, reset) {
  panel.querySelectorAll("[data-zoom]").forEach(button => button.addEventListener("click", () => {
    const action = button.dataset.zoom;
    if (action === "in") zoom(chart, 0.7); else if (action === "out") zoom(chart, 1 / 0.7); else reset();
  }));
}
function buttons(container, items, onPick) {
  container.replaceChildren(...items.map(([value, label]) => {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = label; b.dataset.value = String(value);
    b.addEventListener("click", () => onPick(value));
    return b;
  }));
}
const mark = (container, value) => container.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.value === String(value))));

// ---- state ----
let daily = null, intraday = null, minute = [], sessions = [], today = null;
let frame = null, interval = 1, zoneLines = [];
const dailyChart = makeChart($("daily")), intradayChart = makeChart($("intraday"));
const dailySeries = dailyChart.addSeries(LWC.CandlestickSeries, candleStyle());
const intradaySeries = intradayChart.addSeries(LWC.CandlestickSeries, candleStyle());
const maColors = { 10: "--ma10", 21: "--ma21", 50: "--ma50", 200: "--ma200" };
const maSeries = {};

function toDaily(c) { return { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }; }
function toCandle(b) { return { time: etSeconds(b.t), open: b.o, high: b.h, low: b.l, close: b.c }; }

function todayCandle() {
  if (!today || !daily || daily.unavailable) return null;
  const c = dayCandle(minute, today);
  // A day the daily history already settled is never redrawn from minute bars.
  if (!c || daily.candles.some(d => d.time === today.date)) return null;
  return { time: today.date, open: c.o, high: c.h, low: c.l, close: c.c };
}
function drawDaily() {
  if (!daily || daily.unavailable) return;
  const candles = daily.candles.map(toDaily), live = todayCandle();
  dailySeries.setData(live ? [...candles, live] : candles);
  for (const [period, points] of Object.entries(daily.sma)) {
    maSeries[period] ??= dailyChart.addSeries(LWC.LineSeries, { color: css(maColors[period] || "--muted"), lineWidth: 1,
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, title: `${period}d` });
    maSeries[period].setData(points);
  }
}
function showFrame(name) {
  frame = name; mark($("frames"), name);
  const f = daily.frames.find(x => x.timeframe === name);
  for (const line of zoneLines) dailySeries.removePriceLine(line);
  zoneLines = [];
  const notes = [];
  if (f && !f.unavailable) {
    for (const [side, color] of [["resistance", "--down"], ["support", "--up"]]) for (const z of f[side] || []) {
      for (const [price, edge] of [[z.hi, "top"], [z.lo, "bottom"]]) zoneLines.push(dailySeries.createPriceLine({
        price, color: css(color), lineWidth: 1, lineStyle: LWC.LineStyle.Dashed, axisLabelVisible: edge === "top",
        title: edge === "top" ? `${side === "resistance" ? "R" : "S"} ${z.tests}×` : "" }));
    }
    if (f.bar === "week") notes.push("5Y zones are measured on weekly bars.");
  } else if (f?.unavailable) notes.push(`${f.label}: ${f.unavailable}`);
  const last = daily.candles.at(-1)?.time;
  if (f && last) afterLayout(() => dailyChart.timeScale().setVisibleRange({ from: f.start, to: dailySeries.data().at(-1)?.time ?? last }));
  $("daily-note").textContent = [...notes, ...(daily.warnings || [])].join(" ");
}
// The intraday view is held as a window of time, in epoch ms, and applied by bar position. Lightweight Charts'
// time-based ranges snap to candle left edges, which loses most of a 30-minute candle when switching back to 1-minute.
let candles = [];
// New data is laid out on the chart's next animation frame, and that layout scrolls to its default view, so a range
// set synchronously after setData is overwritten. Views are applied after that frame.
const afterLayout = fn => requestAnimationFrame(() => requestAnimationFrame(fn));
function showWindow(fromMs, toMs) {
  const first = candles.findIndex(c => c.t + interval * 60000 > fromMs);
  let last = -1; for (let i = candles.length - 1; i >= 0; i--) if (candles[i].t <= toMs) { last = i; break; }
  if (first < 0 || last < first) return;
  intradayChart.timeScale().setVisibleLogicalRange({ from: first - 0.5, to: last + 0.5 });
}
function currentWindow() {
  const range = intradayChart.timeScale().getVisibleLogicalRange();
  if (!range || !candles.length) return null;
  const at = i => candles[Math.max(0, Math.min(candles.length - 1, Math.round(i)))];
  return { from: at(range.from).t, to: at(range.to).t + interval * 60000 - 1 };
}
// The latest session that has bars, from its open to its newest bar: today while it trades, else the last full day.
// Never out to a close that has not happened, which would leave most of the panel empty future.
function resetIntraday() {
  const last = minute.at(-1);
  if (!last) return;
  const session = sessions.find(s => last.t >= s.open && last.t < s.close);
  showWindow(session ? session.open : last.t, last.t);
}
function drawIntraday(keepView) {
  const view = keepView ? currentWindow() : null;
  candles = aggregate(minute, interval, sessions);
  intradaySeries.setData(candles.map(toCandle));
  afterLayout(() => { if (view) showWindow(view.from, view.to); else resetIntraday(); });
}
function setInterval_(size) {
  const view = currentWindow();
  interval = size; mark($("intervals"), size);
  candles = aggregate(minute, interval, sessions);
  intradaySeries.setData(candles.map(toCandle));
  afterLayout(() => { if (view) showWindow(view.from, view.to); else resetIntraday(); });
}
function setPrice(price, label) { $("price").textContent = price == null ? "" : `${symbol} ${money(price)}${label ? ` · ${label}` : ""}`; }
function setStatus(state, lastQuoteAt) {
  const s = $("status");
  s.dataset.state = state;
  s.textContent = state === "live" ? `Live${lastQuoteAt ? ` · ${etClock(Date.parse(lastQuoteAt))}` : ""}`
    : state === "stale" ? `Prices stale${lastQuoteAt ? ` · last ${etClock(Date.parse(lastQuoteAt))}` : ""}`
    : state === "closed" ? "Market closed" : state === "connecting" ? "Connecting…" : state;
  document.body.classList.toggle("stale", state === "stale");
}

// A page loaded for one session holds that session's calendar. When the next one starts — a bar from outside it, or
// the status leaving "closed" — the page reloads itself, rather than keep ticking a price beside frozen charts.
// Every automatic reload is rate-limited across reloads (sessionStorage survives them), so a condition that is still
// true after reloading can never become a reload loop.
let lastState = null, reloading = false;
function reloadSoon(reason, minimumWait = 0) {
  if (reloading) return;
  // With storage blocked there is no record of the last reload, so the page waits the full minute every time.
  let last = Date.now();
  try { last = Number(sessionStorage.getItem("astra-chart-reload") || 0); } catch { /* blocked: treated as just reloaded */ }
  const wait = Math.max(minimumWait, last + 60000 - Date.now());
  reloading = true;
  setTimeout(() => {
    try { sessionStorage.setItem("astra-chart-reload", String(Date.now())); } catch { /* ignore */ }
    location.reload();
  }, wait);
  if (wait) setStatus(`${reason} Reloading in ${Math.ceil(wait / 1000)} s…`, null);
}
function newSession() { reloadSoon("A new session started."); }
function onEvent(event) {
  if (event.type === "status") {
    if (lastState === "closed" && event.state !== "closed") return newSession();
    lastState = event.state;
    setStatus(event.state, event.lastQuoteAt);
  } else if (event.type === "bar") {
    const bar = event.bar;
    // Without a known session (the intraday load failed) a bar cannot be placed; the status path still reloads.
    if (!today) return;
    if (bar.t < today.open || bar.t >= today.close) return newSession();
    // The hot path, every couple of seconds: update in place rather than re-sorting the whole history.
    const last = minute[minute.length - 1];
    if (last && bar.t < last.t) {
      // An older minute than the newest (quote time went backwards): the chart cannot update into the past, so redraw.
      minute = mergeBars(minute, [bar]); drawIntraday(true);
      setPrice(event.price, etClock(Date.parse(event.tradeAt)));
      return;
    }
    if (last && last.t === bar.t) minute[minute.length - 1] = bar;
    else minute.push(bar);
    const start = bucketStart(bar.t, interval, [today]);
    const inBucket = [];
    for (let i = minute.length - 1; i >= 0 && minute[i].t >= start; i--) inBucket.unshift(minute[i]);
    const candle = aggregate(inBucket, interval, [today])[0];
    if (candle) {
      intradaySeries.update(toCandle(candle));
      if (candles.length && candles[candles.length - 1].t === candle.t) candles[candles.length - 1] = candle;
      else if (!candles.length || candle.t > candles[candles.length - 1].t) candles.push(candle);
    }
    const live = todayCandle();
    if (live) dailySeries.update(live);
    setPrice(event.price, etClock(Date.parse(event.tradeAt)));
    lastState = "live"; setStatus("live", event.tradeAt);
  } else if (event.type === "bars") {
    // The server's whole state for the window: bars it has since replaced or dropped go from the page too.
    minute = [...minute.filter(b => b.t < event.from || b.t >= event.to), ...event.bars].sort((a, b) => a.t - b.t);
    drawIntraday(true);
    const live = todayCandle();
    if (live) dailySeries.update(live);
  } else if (event.type === "error") {
    // Not final: the server keeps retrying, and a status event follows if the symbol answers again.
    setStatus(event.message, null); lastState = "error";
  }
}

async function load() {
  $("symbol").value = symbol;
  buttons($("intervals"), INTERVALS.map(n => [n, `${n}m`]), setInterval_);
  mark($("intervals"), interval);
  wireZoom($("daily-panel"), dailyChart, () => frame && showFrame(frame));
  wireZoom($("intraday-panel"), intradayChart, resetIntraday);
  if (!symbol) { setStatus("Enter a ticker", null); return; }
  document.title = `${symbol} · Astra chart`;
  setStatus("Loading…", null);
  const get = path => fetch(`${base}/api/${path}?symbol=${encodeURIComponent(symbol)}`).then(async r => {
    const body = await r.json();
    if (!r.ok) throw new Error(body.error || "Request failed");
    return body;
  });
  const [d, i] = await Promise.allSettled([get("daily"), get("intraday")]);
  if (i.status === "fulfilled") {
    intraday = i.value; minute = intraday.bars; sessions = intraday.sessions; today = intraday.today;
    $("intraday-note").textContent = intraday.warnings.join(" ");
    drawIntraday(false);
  } else $("intraday-note").textContent = `Intraday bars unavailable: ${i.reason.message}`;
  if (d.status === "fulfilled" && !d.value.unavailable) {
    daily = d.value;
    buttons($("frames"), FRAMES.filter(([v]) => daily.frames.some(f => f.timeframe === v)), showFrame);
    drawDaily();
    showFrame(daily.defaultTimeframe || "ytd");
    setPrice(daily.price, daily.priceSource === "close" ? `close ${daily.asOf}` : daily.priceSource);
  } else $("daily-note").textContent = `Daily history unavailable: ${d.status === "fulfilled" ? d.value.unavailable : d.reason.message}`;
  const last = minute.at(-1);
  if (last && (!daily || daily.priceSource === "close")) setPrice(last.c, `last bar ${etClock(last.t)}`);
  // Live prices only for a stock Robinhood knows: a mistyped ticker must not join the shared quote batch.
  // A passing failure must not leave the page dead: it tries again, rate-limited like every reload.
  if (!daily && !minute.length) {
    // Three tries, a minute apart: enough to ride out a blip, and a mistyped ticker stops costing reads after that.
    const key = `astra-chart-nodata-${symbol}`;
    let tries = 0; try { tries = Number(sessionStorage.getItem(key) || 0); sessionStorage.setItem(key, String(tries + 1)); } catch { tries = 3; }
    setStatus(`No Robinhood data for ${symbol}.${tries < 3 ? "" : " Check the ticker, or reload to try again."}`, null);
    if (tries < 3) reloadSoon(`No Robinhood data for ${symbol}.`, 60000);
    return;
  }
  try { sessionStorage.removeItem(`astra-chart-nodata-${symbol}`); } catch { /* ignore */ }
  const stream = new EventSource(`${base}/api/stream?symbol=${encodeURIComponent(symbol)}`);
  stream.onmessage = m => { const event = JSON.parse(m.data); onEvent(event); if (event.final) stream.close(); };
  stream.onerror = () => setStatus("Reconnecting…", null);
}

function go() {
  const next = $("symbol").value.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(next)) { setStatus("Invalid ticker", null); return; }
  location.search = `?symbol=${next}`;
}
$("go").addEventListener("click", go);
$("symbol").addEventListener("keydown", e => { if (e.key === "Enter") go(); });
// Exposed for the browser test only: what each panel is drawing right now.
window.__astraChart = {
  intradayCount: () => intradaySeries.data().length,
  intradayLast: () => intradaySeries.data().at(-1),
  dailyLast: () => dailySeries.data().at(-1),
  dailyRange: () => dailyChart.timeScale().getVisibleLogicalRange(),
  intradayRange: () => intradayChart.timeScale().getVisibleLogicalRange(),
  interval: () => interval,
  // Resolves once every view change already queued has been applied.
  settled: () => new Promise(ok => afterLayout(() => afterLayout(ok))),
};
load().catch(error => setStatus(`Could not load: ${error.message}`, null));
