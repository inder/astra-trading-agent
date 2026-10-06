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
// expect: { runaway: boolean, boxStartEt?: "09:46", boxEndEt?: "10:12", decision?: "up"|"down", decisionEndEt?: "10:14" } }.
// Reference days from the brief: SOXL 2026-10-05 (runaway, box from 9:46, up at 10:14); RKT and IBM 2026-10-05 (not runaway).
const folder = process.env.ASTRA_REPLAY_FIXTURES, cases = [["SOXL", "2026-10-05"], ["RKT", "2026-10-05"], ["IBM", "2026-10-05"]] as const;
const et = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit" });
for (const [symbol, date] of cases) {
  const file = folder ? join(folder, `support-box-${symbol}-${date}.json`) : "";
  test(`real bars, ${symbol} ${date}: the scan agrees with the founder's reading`, { skip: !folder ? "set ASTRA_REPLAY_FIXTURES to a private folder of real bars to run this" : !existsSync(file) ? `no ${file}` : false }, () => {
    const { minute, daily, expect } = JSON.parse(readFileSync(file, "utf8")), s = scanDay(minute, daily, boxConfig(date, [symbol]));
    assert.equal(s.runaway.fired, expect.runaway, `runaway gate: ${JSON.stringify(s.runaway.evidence)}`);
    if (!expect.runaway) return assert.deepEqual(s.boxes, []);
    const b = s.boxes.find(x => x.decision);
    assert.ok(b, `a decided box (status ${s.status}, ${s.boxes.length} boxes)`);
    if (expect.boxStartEt) assert.equal(et(b.box.start), expect.boxStartEt);
    if (expect.boxEndEt) assert.equal(et(b.box.end), expect.boxEndEt);
    if (expect.decision) assert.equal(b.decision!.direction, expect.decision);
    if (expect.decisionEndEt) assert.equal(et(b.decision!.candleEnd), expect.decisionEndEt);
  });
}
