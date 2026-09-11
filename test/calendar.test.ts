import { test } from "node:test";
import assert from "node:assert/strict";
import { CalendarCoverageError, isTradingDay, isWeekEnder, tradingSessionsBetween } from "../src/daily-history.ts";
import { EntrySkip, preferredWeeklyExpiration } from "../src/orb-options.ts";
import { loadOrbContracts, type OrbOptionSource } from "../src/option-source.ts";
import { fixture, setup, open } from "./paper-fixture.ts";

// Every Friday plus Mon/Wed dailies and the holiday-week Thursdays, so the rule — not the listing — decides.
const listed = (from: string, to: string) => {
  const out: string[] = [];
  for (let t = Date.parse(from + "T00:00:00Z"); t <= Date.parse(to + "T00:00:00Z"); t += 86400000) {
    const d = new Date(t).toISOString().slice(0, 10), w = new Date(t).getUTCDay();
    if (w === 1 || w === 3 || w === 5 || (w === 4 && !isTradingDay(new Date(t + 86400000).toISOString().slice(0, 10)))) out.push(d);
  }
  return out;
};
const all = listed("2026-01-01", "2027-12-31");

test("expiry follows the founder rule: Mon–Wed that Friday, Thu/Fri the next, at least 3 real sessions", () => {
  const cases: [string, string][] = [
    ["2026-09-08", "2026-09-11"], // Tue after Labor Day: 4 sessions
    ["2026-09-09", "2026-09-11"], // Wed: Wed, Thu, Fri = 3
    ["2026-09-10", "2026-09-18"], // Thu: only 2 to this Friday
    ["2026-09-11", "2026-09-18"], // Fri: same-day expiry never chosen
    ["2026-09-14", "2026-09-18"], // Mon
    ["2026-03-30", "2026-04-02"], // Good Friday week: Thursday weekly, 4 sessions
    ["2026-04-01", "2026-04-10"], // Wed, Thu = 2 → following Friday
    ["2026-06-15", "2026-06-18"], // Juneteenth Friday holiday → Thursday weekly
    ["2026-06-17", "2026-06-26"], // Wed before Juneteenth: 2 sessions → next Friday
    ["2026-06-29", "2026-07-02"], // Independence Day observed Friday → Thursday weekly
    ["2026-11-23", "2026-11-27"], // Thanksgiving week Monday: Mon, Tue, Wed, Fri (half day) = 4
    ["2026-11-25", "2026-12-04"], // Wed before Thanksgiving: Wed, Fri = 2 → following Friday (founder ruling)
    ["2026-12-28", "2026-12-31"], // New Year's Day 2027 is a Friday holiday → Thursday weekly across the year
    ["2026-12-30", "2027-01-08"], // Wed, Thu = 2 → next week-ender is in 2027
    ["2027-03-22", "2027-03-25"], // Good Friday 2027
    ["2027-11-24", "2027-12-03"], // Wed before Thanksgiving 2027
    ["2027-12-27", "2027-12-31"], // last covered week; Friday needs no 2028 lookup
  ];
  for (const [trade, expiry] of cases) assert.equal(preferredWeeklyExpiration(all, trade), expiry, trade);
});
test("expiry is skipped, not substituted, when the target weekly is not listed", () => {
  assert.equal(preferredWeeklyExpiration(["2026-09-18", "2026-10-16"], "2026-09-08"), null); // monthlies only
  assert.equal(preferredWeeklyExpiration(["2026-09-09", "2026-09-14"], "2026-09-08"), null); // dailies only
});
test("a date outside the calendar is an explicit coverage error, never a silent holiday", () => {
  assert.throws(() => preferredWeeklyExpiration(all, "2027-12-30"), CalendarCoverageError); // next week-ender is in 2028
  assert.throws(() => tradingSessionsBetween("2027-12-31", "2028-01-03"), CalendarCoverageError);
  assert.equal(isWeekEnder("2027-12-31"), true); // weekend after it needs no calendar
  assert.throws(() => preferredWeeklyExpiration(all, "2028-01-03"), /Unsupported trade date/);
  assert.equal(isTradingDay("2027-06-18"), false); assert.equal(isTradingDay("2027-07-05"), false); assert.equal(isTradingDay("2027-12-31"), true);
});
test("an unlisted target expiry reaches the journal as a named policy skip", async t => {
  const provider: OrbOptionSource = {
    async equityCallChains(symbol) { return { data: { chains: [{ id: "11111111-1111-1111-1111-111111111111", symbol, can_open_position: true,
      trade_value_multiplier: "100", cash_component: null, expiration_dates: ["2026-09-18"], underlying_instruments: [{ instrument: "i", symbol }] }] } }; },
    async datedCallInstruments() { throw new Error("must not be reached"); },
    async optionQuotes() { throw new Error("must not be reached"); },
  };
  await assert.rejects(loadOrbContracts(provider, "DEMOA", "2026-09-08"), (e: unknown) => e instanceof EntrySkip && e.reason === "no_qualifying_expiry");

  const f = fixture(t);
  f.market.calls = async () => { throw new EntrySkip("no_qualifying_expiry"); };
  f.service.paper.configure(setup); await f.service.paper.start(setup.runId);
  f.setTime(open + 120000); await f.service.paper.tick(setup.runId);
  f.advance(); f.prices.DEMOA = 106; await f.service.paper.tick(setup.runId);
  const skips = f.service.paper.events(setup.runId, -1, 100).flatMap(p => p.events).filter(e => e.type === "entry_skipped");
  assert.deepEqual(skips.map(e => e.data), [{ symbol: "DEMOA", reason: "no_qualifying_expiry" }]);
});
test("a calendar gap and a data failure reach the journal as different skip reasons", async t => {
  for (const [thrown, expected] of [
    [new CalendarCoverageError("Exchange calendar does not cover 2028"), { symbol: "DEMOA", reason: "calendar_not_covered" }],
    [new Error("broker 503"), { symbol: "DEMOA", reason: "data_unavailable", detail: "broker 503" }],
  ] as const) {
    const f = fixture(t);
    f.market.calls = async () => { throw thrown; };
    f.service.paper.configure(setup); await f.service.paper.start(setup.runId);
    f.setTime(open + 120000); await f.service.paper.tick(setup.runId);
    f.advance(); f.prices.DEMOA = 106; await f.service.paper.tick(setup.runId);
    const skips = f.service.paper.events(setup.runId, -1, 100).flatMap(p => p.events).filter(e => e.type === "entry_skipped");
    assert.deepEqual(skips.map(e => e.data), [expected]);
  }
});
