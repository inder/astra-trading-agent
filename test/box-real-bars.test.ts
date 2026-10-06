import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { boxConfig } from "../src/box-settings.ts";
import { scanDay } from "../src/box-rules.ts";

// The reference-day check on REAL bars. Real market data never enters this repository (founder rule), so the bars live in
// a private folder named by ASTRA_REPLAY_FIXTURES. The test skips, saying why, when it is absent. File:
// <folder>/support-box-<SYMBOL>-<YYYY-MM-DD>.json = { minute: [Robinhood minute bars with volume: the 3 sessions before the
// day and the day itself, regular session], daily: { time, open, high, low, close } (split-adjusted daily history),
// expect: { gate?: true (run with the optional runaway gate on; default: on when `runaway` is given, else off), runaway?: boolean (with the gate on),
//           boxStartEt?: "09:46", boxEndEt?: "10:14", decision?: "up"|"down" (the first box decided that way is checked), decisionEndEt?: "10:16" (the CLOSE time of the decision candle),
//           minClusterWithinReach?: number, onlyUpBox?: true } }.
// Reference day from the founder's reading: SOXL 2026-10-05, gate off: box 9:46 to 10:14 (158.08-160.22), decision up on the candle that closes
// at 10:16 (160.71), and no box citing a support above it. RKT and IBM 2026-10-05 are "bad examples" and are expected not to be on the watchlist.
// INTC 2026-10-06 (the founder's own trade, bought 2,000 at 113.44): an up box 12:30 to 12:42 at the daily 20/21 average
// cluster, decided on the candle closing 12:44, with at least three supports within reach.
const folder = process.env.ASTRA_REPLAY_FIXTURES, cases = [["SOXL", "2026-10-05"], ["RKT", "2026-10-05"], ["IBM", "2026-10-05"], ["INTC", "2026-10-06"]] as const;
const et = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit" });
for (const [symbol, date] of cases) {
  const file = folder ? join(folder, `support-box-${symbol}-${date}.json`) : "";
  test(`real bars, ${symbol} ${date}: the scan agrees with the founder's reading`, { skip: !folder ? "set ASTRA_REPLAY_FIXTURES to a private folder of real bars to run this" : !existsSync(file) ? `no ${file}` : false }, () => {
    const { minute, daily, expect } = JSON.parse(readFileSync(file, "utf8")), gate = expect.gate ?? expect.runaway !== undefined, s = scanDay(minute, daily, boxConfig(date, [symbol], { useRunawayGate: gate ? 1 : 0 }));
    assert.ok(!s.unavailable, `daily history: ${JSON.stringify(s.unavailable)}`);
    for (const b of s.boxes) assert.ok((b.support as { lo: number } | null) === null || (b.support as { lo: number }).lo <= b.lowAtFormation, `a box cites a support above it: ${JSON.stringify(b.support)} over ${b.lowAtFormation}`);
    if (gate) assert.equal(s.runaway?.fired, expect.runaway, `runaway gate: ${JSON.stringify(s.runaway?.evidence)}`);
    if (gate && !expect.runaway) return assert.deepEqual(s.boxes, []);
    const b = s.boxes.find(x => x.decision && (!expect.decision || x.decision.direction === expect.decision));
    assert.ok(b, `a decided box (status ${s.status}, ${s.boxes.length} boxes)`);
    if (expect.boxStartEt) assert.equal(et(b.box.start), expect.boxStartEt);
    if (expect.boxEndEt) assert.equal(et(b.box.end), expect.boxEndEt);
    if (expect.decision) assert.equal(b.decision!.direction, expect.decision);
    if (expect.decisionEndEt) assert.equal(et(b.decision!.candleEnd), expect.decisionEndEt);
    if (expect.minClusterWithinReach) assert.ok((b.cluster as { withinReach: number }).withinReach >= expect.minClusterWithinReach, `cluster: ${JSON.stringify(b.cluster)}`);
    if (expect.onlyUpBox) assert.equal(s.boxes.filter(x => x.decision?.direction === "up").length, 1, "no other up decision that day");
  });
}
