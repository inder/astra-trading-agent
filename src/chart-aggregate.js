// Candle-size arithmetic shared by the chart page and its tests. Plain JavaScript because the page inlines this
// file's text (with `export ` stripped) ahead of its own script; one implementation, so the candles a test checks
// are the candles a reader sees.
//
// Bars are { t, o, h, l, c, v } with t the minute's left edge in epoch ms. Sessions are { open, close } in epoch ms.
// Larger candles are aligned to each session's open, so a 30-minute candle is 9:30-10:00 ET, never 9:47-10:17.

/** Left edge of the `minutes`-wide candle containing `t`, or null when `t` falls outside every session. */
export function bucketStart(t, minutes, sessions) {
  const size = minutes * 60000;
  for (const s of sessions) if (t >= s.open && t < s.close) return s.open + Math.floor((t - s.open) / size) * size;
  return null;
}

/** 1-minute bars rolled up into `minutes`-wide candles: first open, highest high, lowest low, last close, summed
 *  volume. Bars outside every session are left out rather than forced into a candle. */
export function aggregate(bars, minutes, sessions) {
  if (minutes === 1) return bars.filter(b => bucketStart(b.t, 1, sessions) !== null).map(b => ({ ...b }));
  const out = [];
  for (const b of bars) {
    const start = bucketStart(b.t, minutes, sessions);
    if (start === null) continue;
    const last = out[out.length - 1];
    if (last && last.t === start) {
      last.h = Math.max(last.h, b.h); last.l = Math.min(last.l, b.l); last.c = b.c; last.v += b.v;
    } else out.push({ t: start, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
  }
  return out;
}

/** Today's daily candle from its minute bars, or null before the first one. */
export function dayCandle(bars, session) {
  const today = bars.filter(b => b.t >= session.open && b.t < session.close);
  if (!today.length) return null;
  return { o: today[0].o, h: Math.max(...today.map(b => b.h)), l: Math.min(...today.map(b => b.l)), c: today[today.length - 1].c,
    v: today.reduce((n, b) => n + b.v, 0) };
}

/** Merges `incoming` 1-minute bars into the sorted `bars` by time: a bar for a minute already held replaces it. */
export function mergeBars(bars, incoming) {
  const byTime = new Map(bars.map(b => [b.t, b]));
  for (const b of incoming) byTime.set(b.t, b);
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}
