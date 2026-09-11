import { addDays, calendarCovers, isEarlyClose, isTradingDay, sessionTimes, SUPPORTED_YEARS } from "./daily-history.ts";
import { ENTRY_WINDOW_MINUTES, MIN_EXPIRY_SESSIONS, OPENING_RANGE_MINUTES, SETTINGS, weeklyExpiryTarget } from "./orb-options.ts";
import { startDeadline } from "./paper-controller.ts";

/** Given to every connected chat model at initialization. Clients that ignore it still get the same lead from the
 *  `next` guide on tool results. */
export const SERVER_INSTRUCTIONS = `Astra simulates one options strategy on paper, using real Robinhood market data. It never places real orders.

Lead the user; many are new to this. Don't wait for them to ask what to do next.
- At the start of a conversation, and whenever you are unsure what comes next, call get_readiness and follow its guide.
- A guide has: explain (what Astra can do at this step, in plain words), ask (one question with a suggested answer), and next (the tool, and whether to call it now or after the user answers).
- Reply with a short plain-language explanation, then exactly one question with the suggested answer or defaults. End every reply with the next step.
- Do the steps that need no decision yourself: checking status, creating the Robinhood approval link, waiting for the approval, checking tickers.
- Only the user approves Robinhood in their browser on this computer, chooses tickers, changes settings, and says yes to starting or resuming a paper run.
- Never ask for passwords, codes or tokens. Call start_paper_run or resume_paper_run only after the user says yes to the specific plan you showed (tickers, date, dollar limits). Paper results are simulations, not real trades or money.`;

const RULES = "Paper only: simulated trades, no real orders or money. Never ask for passwords, codes or tokens. Start or resume a run only after the user says yes to the plan you showed.";

type BrokerState = "not_connected" | "preparing" | "awaiting_authorization" | "verifying" | "connected" | "failed";
export interface GuideRun {
  runId: string; strategyId: string; date: string; status: "configured" | "running" | "stopped" | "completed" | "error";
  attached: boolean; needsSettlement: boolean; positions: number;
  /** When the plan was saved, and its pinned settings: needed only for runs that are not completed. */
  at?: string; config?: unknown;
}
export interface GuideInput {
  now: number; strategyId: string; runs: GuideRun[];
  /** paperDataAvailable: every market-data read a paper run needs is authorized. */
  broker: { state: BrokerState; paperDataAvailable: boolean; authorizationExpiresAt: string | null };
}
export type Stage = "connect_robinhood" | "awaiting_robinhood" | "robinhood_missing_tools" | "choose_symbols" | "start_run" |
  "ready_for_session" | "monitoring" | "resume_run" | "settle_run" | "calendar_ended";
export interface SessionInfo {
  date: string; day: string; today: boolean; earlyClose: boolean;
  opens: string; latestStart: string; entriesUntil: string; closeOut: string; closes: string;
}
export interface Guide {
  stage: Stage;
  /** Where things stand, in one line. */
  status: string;
  /** What Astra can do at this step, in plain words, to relay before asking. */
  explain: string[];
  /** The one question to end the reply with, including a suggested answer. */
  ask: string | null;
  /** now: call it yourself without asking. after_user_*: only once the user has answered or said yes. later: nothing to call. */
  next: { tool: string | null; when: "now" | "after_user_answer" | "after_user_yes" | "later"; args?: Record<string, unknown> };
  /** What to do once the user answers. */
  then?: string[];
  session: SessionInfo | null; runId?: string;
  /** The default settings, in configure_paper_strategy's own units and names. */
  defaults?: Record<string, number>;
  rules: string;
}

interface Plan {
  symbols: string[]; perTradeCents: number; perDayCents: number; positions: number; minimumContracts: number;
  entryWindowMinutes: number; first: number; middle: number; final: number; backstop: number; stopBuffer: number; flattenLeadMinutes: number;
}
const DEFAULT_PLAN: Plan = { symbols: [], perTradeCents: SETTINGS.budgetCentsPerPosition.default, perDayCents: SETTINGS.budgetCentsPerDay.default,
  positions: SETTINGS.maximumPositions.default, minimumContracts: SETTINGS.minimumContracts.default, entryWindowMinutes: ENTRY_WINDOW_MINUTES.default,
  first: SETTINGS.firstTargetMultiple.default, middle: SETTINGS.middleTargetMultiple.default, final: SETTINGS.finalTargetMultiple.default,
  backstop: SETTINGS.backstopFraction.default, stopBuffer: SETTINGS.stopBufferFraction.default, flattenLeadMinutes: SETTINGS.flattenLeadMinutes.default };
/** A saved run's pinned settings, or null when they don't look like this strategy's. */
function planOf(config: unknown): Plan | null {
  const c = config as Record<string, unknown> | null;
  const n = (k: string) => typeof c?.[k] === "number" ? c[k] as number : NaN;
  const plan: Plan = { symbols: Array.isArray(c?.symbols) ? c.symbols.filter((s): s is string => typeof s === "string") : [],
    perTradeCents: n("budgetCentsPerPosition"), perDayCents: n("budgetCentsPerDay"), positions: n("maximumPositions"), minimumContracts: n("minimumContracts"),
    entryWindowMinutes: n("entryWindowMinutes"), first: n("firstTargetMultiple"), middle: n("middleTargetMultiple"), final: n("finalTargetMultiple"),
    backstop: n("backstopFraction"), stopBuffer: n("stopBufferFraction"), flattenLeadMinutes: n("flattenLeadMinutes") };
  return plan.symbols.length && Object.values(plan).every(v => typeof v !== "number" || Number.isFinite(v)) ? plan : null;
}

const ZONE = "America/New_York";
/** The New York calendar date of an instant. */
export const etDate = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
// ICU puts a narrow no-break space before AM/PM; plain spaces read the same everywhere.
const clock = (ms: number) => new Intl.DateTimeFormat("en-US", { timeZone: ZONE, hour: "numeric", minute: "2-digit" }).format(ms).replace(/\s/g, " ") + " ET";
const day = (date: string) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" }).format(Date.parse(date + "T12:00:00Z"));
const dollars = (cents: number) => "$" + (cents / 100).toLocaleString("en-US");
const percent = (fraction: number) => `${Number((fraction * 100).toPrecision(12))}%`;
const count = (n: number, thing: string) => `${n} ${thing}${n === 1 ? "" : "s"}`;

function describeSession(date: string, now: number, plan: Plan = DEFAULT_PLAN): SessionInfo {
  const { open, close } = sessionTimes(date);
  return { date, day: day(date), today: etDate(now) === date, earlyClose: isEarlyClose(date), opens: clock(open), latestStart: clock(startDeadline(date)),
    entriesUntil: clock(Math.min(open + plan.entryWindowMinutes * 60000, close)), closeOut: clock(close - plan.flattenLeadMinutes * 60000), closes: clock(close) };
}
/** The first session a new run can still start for: today until its start deadline, then the next trading day. A date a
 *  started run already used is skipped (one run per strategy and session). null past the calendar's coverage. */
export function nextSessionDate(now: number, used: ReadonlySet<string>): string | null {
  for (let date = etDate(now); calendarCovers(date); date = addDays(date, 1))
    if (isTradingDay(date) && now < startDeadline(date) && !used.has(date)) return date;
  return null;
}
const sessionOpen = (date: string, now: number) => { try { return now < sessionTimes(date).close; } catch { return false; } };

function strategyLines(p: Plan, s: SessionInfo): string[] {
  return [
    `Here is what Astra does on ${s.day}, on paper only: simulated trades on real Robinhood prices, no real orders.`,
    `The first ${OPENING_RANGE_MINUTES} minutes after the ${s.opens} open set each stock's opening high and low.`,
    `If a stock then trades above that high before ${s.entriesUntil}, Astra buys call options on it. If it trades below the low first, that stock is done for the day.`,
    `Limits: at most ${count(p.positions, "stock")} entered per day, ${dollars(p.perTradeCents)} of option premium per trade and ${dollars(p.perDayCents)} per day.`,
    `Which option: the strike closest to the stock price where at least ${count(p.minimumContracts, "contract")} fit under the per-trade limit, expiring ${day(weeklyExpiryTarget(s.date))} ` +
      `(the first week-ending expiry at least ${MIN_EXPIRY_SESSIONS} trading days out, counting the trade day).`,
    `Exits: half the contracts (rounded up) sell when the option reaches ${p.first}x its entry price${p.first >= 2 ? ", which recovers at least the premium paid" : ""}; ` +
      `the last one sells at ${p.final}x and any in between at ${p.middle}x.`,
    `Stops: before that first sale, a drop ${percent(p.stopBuffer)} below the opening low sells everything; after it, a fall back to the stock's entry price does. ` +
      `A safety stop sells if the option falls to ${percent(p.backstop)} of its entry price, and anything still held sells at ${s.closeOut}.`,
    "Premium is treated as money you can lose in full; the per-trade and per-day limits are the risk control. Every number here is a setting you can change.",
  ];
}
function planLines(p: Plan, s: SessionInfo): string[] {
  return [
    `Watches ${p.symbols.join(", ")} on ${s.day}; new entries until ${s.entriesUntil}.`,
    `Up to ${count(p.positions, "stock")}, ${dollars(p.perTradeCents)} per trade and ${dollars(p.perDayCents)} per day in paper premium.`,
    `Exits at ${p.first}x, ${p.middle}x and ${p.final}x; safety stop at ${percent(p.backstop)} of the entry price; everything left sells at ${s.closeOut}.`,
  ];
}
const keepOpen = (s: SessionInfo) => `Keep the app running Astra open until ${s.closes}. If it closes, monitoring stops; open positions are kept and can be resumed after you reconnect Robinhood.`;
const CONNECT = [
  "Setup has three steps: connect Robinhood market data, pick the stocks to watch, then start a paper run on a trading morning.",
  "Astra watches the stocks you pick at the market open and simulates option trades on real Robinhood prices. It never places real orders, and no money moves.",
  "To see those prices it needs read-only access to Robinhood market data. You approve that on Robinhood's own website, in a browser on this computer; Astra never sees your password.",
  "The approval lasts until this app restarts; after a restart you approve again.",
];

/** Astra's next step for the user, from live state: what to explain, the one question to ask, and the tool to call. */
export function setupGuide(input: GuideInput): Guide {
  const { now, broker } = input, runs = input.runs.filter(r => r.strategyId === input.strategyId);
  // Every status past "configured" went through a start, which reserves its date for this strategy.
  const used = new Set(runs.filter(r => r.status !== "configured").map(r => r.date));
  const sessionDate = nextSessionDate(now, used);
  const session = sessionDate ? describeSession(sessionDate, now) : null;
  const make = (g: Omit<Guide, "rules" | "session"> & { session?: SessionInfo | null }): Guide => ({ session, ...g, rules: RULES });
  const connecting = (status: string, context: string[], runId?: string, fresh = false): Guide => {
    if (["preparing", "awaiting_authorization", "verifying"].includes(broker.state)) return make({ stage: "awaiting_robinhood", runId,
      status: `Waiting for your approval of Robinhood market-data access in the browser${broker.authorizationExpiresAt ? ` (the link works until ${clock(Date.parse(broker.authorizationExpiresAt))})` : ""}.`,
      explain: [...context, "On Robinhood's page, sign in if asked, review the requested access and approve it. Astra uses only market-data reads; its code blocks order tools.",
        "Lost the link? connect_robinhood returns the same one while it is valid."],
      ask: "Approve it in your browser; I'm checking automatically, so there's no need to type \"done\".",
      next: { tool: "wait_for_robinhood", when: "now" },
      then: ["Keep calling wait_for_robinhood while it reports still_waiting. If a few checks pass without approval, stop and ask the user to reply once they have approved.",
        "If it reports expired or declined_or_failed, offer a new link (connect_robinhood)."] });
    if (broker.state === "connected") return make({ stage: "robinhood_missing_tools", runId,
      status: "Robinhood is connected, but it did not grant all the market-data tools paper runs need (stock quotes may still work).",
      explain: [...context, "Paper runs need Robinhood's stock quotes, price history, option chains, option instruments and option quotes.",
        "A fresh approval that grants all the requested market-data access usually fixes this. Restarting this app clears the current connection."],
      ask: "Restart this app, then send any message and I'll create a new approval link. (Suggested: do that now.)", next: { tool: null, when: "later" } });
    return make({ stage: "connect_robinhood", runId,
      status: broker.state === "failed" ? "The last Robinhood approval did not complete: it was declined or could not be verified." : status,
      explain: [...context, ...(fresh ? CONNECT : CONNECT.slice(2))],
      ask: "Open the link I'm creating in a browser on this computer, sign in to Robinhood and approve. I'll wait here and continue as soon as it's done.",
      next: { tool: "connect_robinhood", when: "now" },
      then: ["Share the authorizationUrl from connect_robinhood as a link, then call wait_for_robinhood."] });
  };

  // Money first: positions nobody is managing, then a run in progress, then planning the next session.
  const unsettled = runs.find(r => r.needsSettlement);
  if (unsettled) return make({ stage: "settle_run", runId: unsettled.runId,
    status: `Paper run ${unsettled.runId} (${day(unsettled.date)}) ended its session still holding ${count(unsettled.positions, "position")}.`,
    explain: ["Astra sells everything before the close, but this run was not being monitored then (the app was closed, or the run was stopped or halted), so those contracts were never sold.",
      "Settling records them the way the strategy treats unsold options at the close: a total loss of their remaining premium. It is paper bookkeeping: no real money or orders, and no Robinhood connection needed."],
    ask: `Settle run ${unsettled.runId} now? (Suggested: yes; until then its results stay incomplete.)`,
    next: { tool: "resume_paper_run", when: "after_user_yes", args: { runId: unsettled.runId } } });

  const orphan = runs.find(r => !r.attached && r.positions > 0 && ["running", "stopped", "error"].includes(r.status) && sessionOpen(r.date, now));
  if (orphan) {
    const plan = planOf(orphan.config) ?? DEFAULT_PLAN, s = describeSession(orphan.date, now, plan);
    const why = orphan.status === "running" ? "Astra restarted, so nothing is managing them right now"
      : orphan.status === "stopped" ? "the run was stopped, so their automated exits are off"
      : "the run halted after market data failed for too long (get_paper_run shows why)";
    const status = `Paper run ${orphan.runId} has ${count(orphan.positions, "open position")}, and ${why}.`;
    const lines = [`Resuming makes Astra manage them again: profit targets, stops and the ${s.closeOut} close-out. It never opens new trades after a gap.`,
      "If they are not resumed, anything still held at the close counts as a total loss."];
    if (!broker.paperDataAvailable) return connecting(status,
      [...lines, "To manage them Astra needs Robinhood prices again; approvals live only in memory, so after a restart you approve again. Once connected, I'll ask you to resume."], orphan.runId);
    return make({ stage: "resume_run", runId: orphan.runId, session: s, status, explain: lines,
      ask: `Resume managing run ${orphan.runId}'s positions now? (Suggested: yes${orphan.status === "stopped" ? ", unless you stopped it on purpose" : ""}.)`,
      next: { tool: "resume_paper_run", when: "after_user_yes", args: { runId: orphan.runId } } });
  }

  const live = runs.find(r => r.attached && r.status === "running");
  if (live) {
    const plan = planOf(live.config) ?? DEFAULT_PLAN, s = describeSession(live.date, now, plan), { open } = sessionTimes(live.date);
    const phase = now < open ? `It waits for the ${s.opens} open; each stock's opening range is set by ${s.latestStart}.`
      : now < open + plan.entryWindowMinutes * 60000 ? `New entries are possible until ${s.entriesUntil}; open positions are managed until ${s.closeOut}.`
      : `The entry window is over; open positions are managed until ${s.closeOut}.`;
    return make({ stage: "monitoring", runId: live.runId, session: s,
      status: `Paper run ${live.runId} is running for ${s.day}${plan.symbols.length ? `, watching ${plan.symbols.join(", ")}` : ""}.`,
      explain: [phase, keepOpen(s)],
      ask: "Want the current positions and paper P&L? (Suggested: yes. You can also ask me to trim or close a position, which you approve in your browser.)",
      next: { tool: "get_paper_run", when: "after_user_yes", args: { runId: live.runId } } });
  }

  if (!session) return make({ stage: "calendar_ended",
    status: `Astra's exchange calendar covers ${SUPPORTED_YEARS[0]}–${SUPPORTED_YEARS.at(-1)}, so there is no later session it can plan.`,
    explain: ["Update Astra to a version with the next year's exchange calendar."], ask: null, next: { tool: null, when: "later" } });

  // Saved plans that can still start (no started run holds their date), earliest session first, newest plan first within a date.
  const saved = runs.filter(r => r.status === "configured" && !used.has(r.date))
    .sort((a, b) => a.date.localeCompare(b.date) || (b.at ?? "").localeCompare(a.at ?? ""));
  const planned = saved.find(r => r.date >= session.date);
  const plannedPlan = planned ? planOf(planned.config) ?? DEFAULT_PLAN : DEFAULT_PLAN;
  const plannedSession = planned ? describeSession(planned.date, now, plannedPlan) : session;
  if (planned && !plannedSession.today) {
    const plan = plannedPlan, s = plannedSession;
    return make({ stage: "ready_for_session", runId: planned.runId, session: s, status: `Your paper run ${planned.runId} is set up for ${s.day}.`,
      explain: [...planLines(plan, s), `On ${s.day}, open this app before ${s.opens} and send any message. Astra will ask you to approve Robinhood again ` +
        `(approvals don't survive a restart) and then to start the run. The latest start is ${s.latestStart}.`, keepOpen(s)],
      ask: `Anything you'd like to change before ${s.day}? (Suggested: no, it's ready.)`, next: { tool: null, when: "later" },
      then: ["Saved plans can't be edited: for changes, configure a new plan with a new runId for the same date. The newest plan for a date is the one Astra offers to start."] });
  }
  if (!broker.paperDataAvailable) return planned
    ? connecting(`Your paper run ${planned.runId} is set up for today. First, connect Robinhood market data.`,
      [`Your run ${planned.runId} can start until ${plannedSession.latestStart}. Once Robinhood is connected, I'll ask you to start it.`], planned.runId)
    : input.runs.length
      ? connecting("Robinhood isn't connected (approvals don't survive a restart). Next: reconnect it.", [])
      : connecting("Astra is installed and working. Next: connect Robinhood market data.", [], undefined, true);
  if (planned) {
    const plan = plannedPlan, s = plannedSession;
    return make({ stage: "start_run", runId: planned.runId, session: s, status: `Your paper run ${planned.runId} for today (${s.day}) is ready to start.`,
      explain: [...planLines(plan, s), `Start any time before ${s.latestStart}. Starting early is fine: Astra waits for the open.`, keepOpen(s)],
      ask: `Start run ${planned.runId} now? (Suggested: yes.)`, next: { tool: "start_paper_run", when: "after_user_yes", args: { runId: planned.runId } } });
  }

  const missed = saved.filter(r => r.date < session.date).sort((a, b) => b.date.localeCompare(a.date) || (b.at ?? "").localeCompare(a.at ?? ""))[0];
  const missedPlan = missed ? planOf(missed.config) : null;
  const finished = runs.find(r => r.status === "completed" && r.date === etDate(now));
  const ids = new Set(input.runs.map(r => r.runId));
  let runId = `orb-${session.date}`;
  for (let i = 2; ids.has(runId); i++) runId = `orb-${session.date}-${i}`;
  const p = DEFAULT_PLAN;
  return make({ stage: "choose_symbols", runId,
    status: `Robinhood is connected. Next: plan a paper run for ${session.day}.`,
    explain: [
      ...(finished ? [`Today's run ${finished.runId} is finished; ask for today's paper results any time.`] : []),
      ...(missed && missedPlan ? [`Your saved plan ${missed.runId} for ${day(missed.date)} never started; a run must start before ${clock(startDeadline(missed.date))} on its day.`] : []),
      ...strategyLines(p, session)],
    ask: `Which stocks should Astra watch on ${session.day}? Pick ${p.positions + 1} to ${p.positions + 3} that trade heavily and have weekly options; ` +
      `Astra enters at most ${count(p.positions, "stock")} a day, so extras give it choices. Send the tickers and I'll check each one.` +
      (missedPlan ? ` Or say "same as before" to reuse ${missedPlan.symbols.join(", ")}.` : ""),
    next: { tool: "check_symbols", when: "after_user_answer" },
    then: [
      "Call check_symbols with the tickers. Say plainly which work and why any don't, and suggest replacing those.",
      `Show the plan in a short list: the tickers, ${session.day}, ${dollars(p.perTradeCents)} per trade, ${dollars(p.perDayCents)} per day, entries until ${session.entriesUntil}, ` +
        `exits at ${p.first}x/${p.middle}x/${p.final}x, safety stop at ${percent(p.backstop)}, close-out at ${session.closeOut}. Ask for a yes or any changes.`,
      `On yes, call configure_paper_strategy with runId "${runId}", strategyId "${input.strategyId}", date "${session.date}", the tickers, includePremarket false, ` +
        "and only the settings the user changed. It saves the plan; it does not start anything.",
    ],
    defaults: { maxPremiumPerTradeDollars: p.perTradeCents / 100, maxPremiumPerDayDollars: p.perDayCents / 100, maximumPositions: p.positions,
      minimumContracts: p.minimumContracts, entryWindowMinutes: p.entryWindowMinutes, firstTargetMultiple: p.first, middleTargetMultiple: p.middle,
      finalTargetMultiple: p.final, backstopPercent: Number((p.backstop * 100).toPrecision(12)), stopBufferPercent: Number((p.stopBuffer * 100).toPrecision(12)),
      flattenLeadMinutes: p.flattenLeadMinutes } });
}
