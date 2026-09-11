import { test } from "node:test";
import assert from "node:assert/strict";
import { nextSessionDate, setupGuide, SERVER_INSTRUCTIONS, type Guide, type GuideInput, type GuideRun } from "../src/setup-guide.ts";
import { openingRangeConfig } from "../src/orb-config.ts";
import { ENTRY_WINDOW_MINUTES, SETTINGS } from "../src/orb-options.ts";

// New York wall-clock instants: September is EDT (-04:00), December EST (-05:00).
const at = (iso: string) => Date.parse(iso);
const FRIDAY_EVENING = at("2026-09-11T17:48:00-04:00"), MONDAY = "2026-09-14";
const strategyId = "opening-range-options";
const plan = (date = MONDAY, symbols = ["DEMOA", "DEMOB", "DEMOC"], settings = {}) => openingRangeConfig({ date, symbols, includePremarketLeadMinutes: 0, ...settings });
const run = (over: Partial<GuideRun> = {}): GuideRun => ({ runId: "plan-one", strategyId, date: MONDAY, status: "configured", attached: false,
  needsSettlement: false, positions: 0, at: "2026-09-11T21:00:00.000Z", config: plan(over.date), ...over });
const disconnected = { state: "not_connected" as const, paperDataAvailable: false, authorizationExpiresAt: null };
const connected = { state: "connected" as const, paperDataAvailable: true, authorizationExpiresAt: null };
const seen: Guide[] = [];
function guide(over: Partial<GuideInput> = {}): Guide {
  const g = setupGuide({ now: FRIDAY_EVENING, strategyId, runs: [], broker: disconnected, ...over });
  seen.push(g); return g;
}
const text = (g: Guide) => [g.status, ...g.explain, g.ask ?? "", ...(g.then ?? [])].join("\n");
const dollars = (cents: number) => "$" + (cents / 100).toLocaleString("en-US");

test("a fresh install explains what Astra is, then creates the Robinhood link itself", () => {
  const g = guide();
  assert.equal(g.stage, "connect_robinhood"); assert.deepEqual(g.next, { tool: "connect_robinhood", when: "now" });
  assert.match(g.status, /installed and working/);
  assert.match(g.explain[0]!, /three steps/);
  assert.match(text(g), /never places real orders/); assert.match(text(g), /Astra never sees your password/);
  assert.match(g.ask!, /browser on this computer/);
});
test("a returning user is asked to reconnect, not onboarded again; a failed approval says so", () => {
  const history = [run({ runId: "old", date: "2026-09-10", status: "completed" })];
  const back = guide({ runs: history });
  assert.equal(back.stage, "connect_robinhood"); assert.match(back.status, /reconnect/);
  assert.ok(!text(back).includes("three steps"));
  assert.match(guide({ broker: { ...disconnected, state: "failed" } }).status, /declined or could not be verified/);
});
test("while approval is pending the model waits itself, and the link's expiry is shown in New York time", () => {
  for (const state of ["preparing", "awaiting_authorization", "verifying"] as const) {
    const g = guide({ broker: { state, paperDataAvailable: false, authorizationExpiresAt: state === "awaiting_authorization" ? "2026-09-11T22:00:00.000Z" : null } });
    assert.equal(g.stage, "awaiting_robinhood"); assert.deepEqual(g.next, { tool: "wait_for_robinhood", when: "now" });
    assert.match(g.ask!, /no need to type "done"/);
    if (state === "awaiting_authorization") assert.match(g.status, /until 6:00 PM ET/);
  }
});
test("connected without every paper data tool explains the gap and calls nothing", () => {
  const g = guide({ broker: { state: "connected", paperDataAvailable: false, authorizationExpiresAt: null } });
  assert.equal(g.stage, "robinhood_missing_tools"); assert.equal(g.next.tool, null);
});
test("once connected it explains the strategy with the setting defaults, then asks for tickers with guidance", () => {
  const g = guide({ broker: connected });
  assert.equal(g.stage, "choose_symbols"); assert.deepEqual(g.next, { tool: "check_symbols", when: "after_user_answer" });
  assert.equal(g.session?.date, MONDAY); assert.equal(g.session?.day, "Monday, September 14"); assert.equal(g.session?.today, false);
  // Each explanation line states its own numbers, from the settings (a number elsewhere in the guide doesn't count).
  const line = (prefix: string) => g.explain.find(l => l.startsWith(prefix)) ?? "";
  const expect: [string, string[]][] = [
    ["Here is", ["on paper only", "no real orders"]],
    ["If a stock", ["before 11:00 AM ET", "done for the day"]],
    ["Limits:", [`at most ${SETTINGS.maximumPositions.default} stocks entered per day`, `${dollars(SETTINGS.budgetCentsPerPosition.default)} of option premium per trade`,
      `${dollars(SETTINGS.budgetCentsPerDay.default)} per day`]],
    ["Which option:", [`at least ${SETTINGS.minimumContracts.default} contracts`, "expiring Friday, September 18"]],
    ["Exits:", [`reaches ${SETTINGS.firstTargetMultiple.default}x`, `at ${SETTINGS.finalTargetMultiple.default}x`, `at ${SETTINGS.middleTargetMultiple.default}x`]],
    ["Stops:", [`${SETTINGS.stopBufferFraction.default * 100}% below the opening low`, `${SETTINGS.backstopFraction.default * 100}% of its entry price`, "at 3:59 PM ET"]],
    ["Premium", ["money you can lose in full", "a setting you can change"]],
  ];
  for (const [prefix, parts] of expect) for (const part of parts) assert.ok(line(prefix).includes(part), `${prefix} ${part}`);
  assert.equal(ENTRY_WINDOW_MINUTES.default, 90);   // 11:00 AM ET above is the 90-minute default after the open
  assert.deepEqual(g.defaults, { maxPremiumPerTradeDollars: 2000, maxPremiumPerDayDollars: 4000, maximumPositions: 2, minimumContracts: 4,
    entryWindowMinutes: 90, firstTargetMultiple: 2, middleTargetMultiple: 3, finalTargetMultiple: 5, backstopPercent: 50, stopBufferPercent: 0.1, flattenLeadMinutes: 1 });
  assert.match(g.ask!, /Pick 3 to 5 .*at most 2 stocks a day/);
  assert.ok(!/\b(?!AM\b|PM\b|ET\b)[A-Z]{2,5}\b/.test(g.ask!), "names no tickers");
  assert.equal(g.runId, "orb-2026-09-14");
  assert.match(g.then![2]!, /configure_paper_strategy with runId "orb-2026-09-14", strategyId "opening-range-options", date "2026-09-14"/);
  assert.match(g.then![2]!, /does not start anything/);
});
test("the next session is today until 9:32 ET, then the next trading day; weekends, holidays and used dates are skipped", () => {
  const none = new Set<string>();
  assert.equal(nextSessionDate(at("2026-09-14T09:31:59-04:00"), none), MONDAY);
  assert.equal(nextSessionDate(at("2026-09-14T09:32:00-04:00"), none), "2026-09-15");
  assert.equal(nextSessionDate(at("2026-09-04T10:00:00-04:00"), none), "2026-09-08");   // Monday 7 September is Labor Day
  assert.equal(nextSessionDate(at("2026-09-12T12:00:00-04:00"), none), MONDAY);
  assert.equal(nextSessionDate(at("2026-09-12T12:00:00-04:00"), new Set([MONDAY])), "2026-09-15");
  assert.equal(nextSessionDate(at("2027-12-31T17:00:00-05:00"), none), null);   // past the calendar's last year
  assert.equal(nextSessionDate(at("2026-09-14T23:30:00-04:00"), none), "2026-09-15");   // already the 15th in UTC
  const suggested = guide({ broker: connected, runs: [run({ runId: "orb-2026-09-14", status: "configured", date: "2026-09-10" })] });
  assert.equal(suggested.runId, "orb-2026-09-14-2");   // suggested names never collide with a saved run
});
test("early-close sessions use the 1:00 PM close", () => {
  const g = guide({ now: at("2026-11-26T12:00:00-05:00"), broker: connected });
  assert.equal(g.session?.date, "2026-11-27"); assert.equal(g.session?.earlyClose, true);
  assert.equal(g.session?.closes, "1:00 PM ET"); assert.equal(g.session?.closeOut, "12:59 PM ET");
  assert.match(text(g), /expiring Friday, December 4/);
});
test("a plan saved for a later session is ready without a connection, with one instruction for that morning", () => {
  const g = guide({ runs: [run()] });
  assert.equal(g.stage, "ready_for_session"); assert.equal(g.runId, "plan-one"); assert.deepEqual(g.next, { tool: null, when: "later" });
  assert.match(text(g), /On Monday, September 14, open this app before 9:30 AM ET and send any message/);
  assert.match(text(g), /The latest start is 9:32 AM ET/); assert.match(text(g), /Watches DEMOA, DEMOB, DEMOC/);
  const later = guide({ broker: connected, runs: [run({ date: "2026-09-16", config: plan("2026-09-16") })] });
  assert.equal(later.stage, "ready_for_session"); assert.equal(later.session?.date, "2026-09-16");   // an explicit later plan waits
});
test("a plan saved for today: connect first, then start only after a yes; the newest plan for a date wins", () => {
  const morning = at("2026-09-14T08:00:00-04:00");
  const older = run({ runId: "older", at: "2026-09-11T20:00:00.000Z" }), newer = run({ runId: "newer", at: "2026-09-13T20:00:00.000Z",
    config: plan(MONDAY, ["DEMOA"], { maximumPositions: 3, budgetCentsPerPosition: 150000 }) });
  const first = guide({ now: morning, runs: [older, newer] });
  assert.equal(first.stage, "connect_robinhood"); assert.equal(first.runId, "newer"); assert.match(text(first), /I'll ask you to start it/);
  const g = guide({ now: morning, broker: connected, runs: [older, newer] });
  assert.equal(g.stage, "start_run"); assert.deepEqual(g.next, { tool: "start_paper_run", when: "after_user_yes", args: { runId: "newer" } });
  assert.match(text(g), /Up to 3 stocks, \$1,500 per trade/); assert.match(g.ask!, /Start run newer now\?/);
});
test("a plan that missed its start is named, and its tickers are offered again for the next session", () => {
  const g = guide({ now: at("2026-09-14T10:00:00-04:00"), broker: connected, runs: [run()] });
  assert.equal(g.stage, "choose_symbols"); assert.equal(g.session?.date, "2026-09-15");
  assert.match(text(g), /plan-one for Monday, September 14 never started; a run must start before 9:32 AM ET/);
  assert.match(g.ask!, /"same as before" to reuse DEMOA, DEMOB, DEMOC/);
});
test("a finished run's date is not offered again, and today's results are mentioned", () => {
  const g = guide({ now: at("2026-09-14T16:30:00-04:00"), broker: connected, runs: [run({ status: "completed" })] });
  assert.equal(g.stage, "choose_symbols"); assert.equal(g.session?.date, "2026-09-15"); assert.match(text(g), /Today's run plan-one is finished/);
});
test("unmanaged positions come first: reconnect, then resume only after a yes", () => {
  const midday = at("2026-09-14T11:00:00-04:00");
  for (const status of ["running", "stopped", "error"] as const) {
    const orphan = run({ status, positions: 1 });
    const away = guide({ now: midday, runs: [orphan] });
    assert.equal(away.stage, "connect_robinhood"); assert.equal(away.runId, "plan-one");
    assert.match(text(away), /Once connected, I'll ask you to resume/);
    const g = guide({ now: midday, broker: connected, runs: [orphan] });
    assert.equal(g.stage, "resume_run"); assert.deepEqual(g.next, { tool: "resume_paper_run", when: "after_user_yes", args: { runId: "plan-one" } });
    assert.match(text(g), /never opens new trades after a gap/); assert.match(text(g), /total loss/);
    if (status === "stopped") assert.match(g.ask!, /unless you stopped it on purpose/);
    if (status === "error") assert.match(g.status, /halted/);
  }
  assert.equal(guide({ now: at("2026-09-14T16:30:00-04:00"), broker: connected, runs: [run({ status: "running", positions: 1 })] }).stage,
    "choose_symbols");   // after the close there is nothing left to resume (settlement is flagged separately)
});
test("a run holding contracts after its session is settled only after a yes that it counts as a total loss", () => {
  const g = guide({ now: at("2026-09-14T17:00:00-04:00"), runs: [run({ status: "stopped", positions: 2, needsSettlement: true })] });
  assert.equal(g.stage, "settle_run"); assert.deepEqual(g.next, { tool: "resume_paper_run", when: "after_user_yes", args: { runId: "plan-one" } });
  assert.match(text(g), /total loss of their remaining premium/); assert.match(text(g), /no Robinhood connection needed/);
});
test("a running run reports what it is doing now, and that the app must stay open", () => {
  const live = run({ status: "running", attached: true });
  const phases: [string, RegExp][] = [["2026-09-14T09:00:00-04:00", /waits for the 9:30 AM ET open/],
    ["2026-09-14T10:00:00-04:00", /New entries are possible until 11:00 AM ET/], ["2026-09-14T12:00:00-04:00", /entry window is over/]];
  for (const [when, phase] of phases) {
    const g = guide({ now: at(when), broker: connected, runs: [live] });
    assert.equal(g.stage, "monitoring"); assert.match(g.explain[0]!, phase);
    assert.match(text(g), /Keep the app running Astra open until 4:00 PM ET/);
    assert.deepEqual(g.next, { tool: "get_paper_run", when: "after_user_yes", args: { runId: "plan-one" } });
  }
});
test("near the calendar's end the expiry is described by its rule, and the guide still answers", () => {
  const g = guide({ now: at("2027-12-29T17:00:00-05:00"), broker: connected });
  assert.equal(g.stage, "choose_symbols"); assert.equal(g.session?.date, "2027-12-30");   // its target expiry would be in 2028
  assert.match(g.explain.find(l => l.startsWith("Which option:"))!, /fit under the per-trade limit, with the first week-ending expiry at least 3 trading days out/);
});
test("unreadable saved runs are named and left out, never guessed at", () => {
  const g = guide({ broker: connected, unreadable: ["broken-one"] });
  assert.equal(g.stage, "choose_symbols");
  assert.match(g.explain[0]!, /couldn't read saved run broken-one, so this guide leaves it out rather than guess/);
});
test("after the calendar's last session there is nothing to plan", () => {
  const g = guide({ now: at("2027-12-31T17:00:00-05:00"), broker: connected });
  assert.equal(g.stage, "calendar_ended"); assert.equal(g.next.tool, null); assert.match(g.status, /2026–2027/);
});
test("other strategies' runs don't steer the guide", () => {
  assert.equal(guide({ broker: connected, runs: [run({ strategyId: "test-only", status: "running", attached: true })] }).stage, "choose_symbols");
});
test("every guide keeps the safety rules: no automatic start, resume or save; no credential requests", () => {
  assert.ok(seen.length > 20);
  for (const g of seen) {
    assert.ok(!(["start_paper_run", "resume_paper_run", "configure_paper_strategy", "stop_paper_run"].includes(g.next.tool ?? "") && g.next.when === "now"), g.stage);
    assert.match(g.rules, /Never ask for passwords, codes or tokens/); assert.match(g.rules, /only after the user says yes/);
    assert.ok(!/\b(send|share|paste|enter|type|give)\b[^.]{0,30}\b(password|passcode|code|token)/i.test([g.ask, ...g.explain, ...(g.then ?? [])].join(" ")), g.stage);
  }
  assert.match(SERVER_INSTRUCTIONS, /call get_readiness/); assert.match(SERVER_INSTRUCTIONS, /Never ask for passwords, codes or tokens/);
  assert.match(SERVER_INSTRUCTIONS, /only after the user says yes to the specific plan/); assert.match(SERVER_INSTRUCTIONS, /never places real orders/);
});
