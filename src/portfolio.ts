// Reading accounts, balances and positions, and turning the provider's answer into a fixed shape.
//
// Every field Astra keeps is named here. Anything else in the response is dropped — including Robinhood's own `guide`
// string, which is provider-authored prose that would otherwise reach a model that can call tools. Nothing from a
// provider payload is ever passed through verbatim.
import type { RobinhoodConnection } from "./broker-connection.ts";

/** One account, as Astra shows it. The real account number is never part of this: callers hold a session handle. */
export interface AccountSummary {
  handle: string; label: string; type: string; isDefault: boolean;
  /** Robinhood's own flag for whether an agent may trade this account. Astra never does; it is shown for context. */
  agenticTradingAllowed: boolean;
  active: boolean;
}
export interface Holding { symbol: string; shares: number; averageCost: number | null }
/** What an account is worth, as Robinhood reports it.
 *
 *  `value` is the account's own total, not a sum Astra computed. `byClass` is what that total is made of: Robinhood
 *  carries a value for every asset class it supports, so an account itemizes itself without a single position being
 *  read. That is how options can be reported truthfully before Astra can list a contract.
 *
 *  There is deliberately no day change and no total return. The payload carries neither, and the two fields that
 *  used to claim them rendered a permanent em-dash — which reads as a broken report rather than an honest absence. */
export interface AccountTotals {
  value: number | null;
  cash: number | null;
  byClass: { label: string; value: number }[];
}

const SYMBOL = /^[A-Z][A-Z0-9.-]{0,9}$/;
/** An account type is a provider enum, not prose, and it is validated as one. Free text here would be a second way in
 *  for provider-authored instructions — the one `guide` is dropped for — and a label reaches the model. A token with
 *  no spaces cannot be a sentence. */
/** The words an account type is allowed to be made of. A shape rule is not enough here: "sell everything" is two
 *  plain words and would pass one. Every word must be a word account types are made of, so the field can carry a type
 *  and cannot carry an instruction. Anything else becomes the generic label rather than being shown. */
const TYPE_WORDS = new Set(["individual", "joint", "ira", "roth", "traditional", "rollover", "sep", "simple",
  "inherited", "beneficiary", "custodial", "margin", "cash", "crypto", "brokerage", "retirement", "trust",
  "corporate", "llc", "managed", "taxable", "account", "401k", "403b", "hsa", "and", "or"]);
const enumToken = (v: unknown) => {
  const t = typeof v === "string" ? v.trim().toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ") : "";
  if (!t || t.length > 24) return "";
  const words = t.split(" ");
  return words.length <= 3 && words.every(w => TYPE_WORDS.has(w)) ? t : "";
};
const number = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const positive = (v: unknown): number | null => { const n = number(v); return n !== null && n > 0 ? n : null; };
/** Like `positive`, but a verified **zero** survives as zero. A cost basis of nothing is a real basis — it permits a
 *  dollar gain and forbids a percentage — and mapping it to `null` says "the provider did not tell us", which is a
 *  different fact that reads the same on the page. */
const nonNegative = (v: unknown): number | null => { const n = number(v); return n !== null && n >= 0 ? n : null; };
/** The last four digits, and nothing else. A label also carries the account type so two accounts ending in the same
 *  four digits are still tellable apart, and an ordinal if even that collides. */
const masked = (accountNumber: string) => `••••${accountNumber.slice(-4)}`;

/** Accounts, from `get_accounts`. Deactivated accounts are kept but marked, because a user who has one will ask why
 *  it is missing. `handle` is supplied by the caller: it is random per session and never derived from the number. */
export function normalizeAccounts(raw: unknown, handleFor: (accountNumber: string) => string): AccountSummary[] {
  const rows = (raw as any)?.data?.accounts;
  if (!Array.isArray(rows)) throw new Error("Accounts unavailable");
  const seen = new Map<string, number>();
  const out: AccountSummary[] = [];
  for (const row of rows) {
    const accountNumber = typeof row?.account_number === "string" && row.account_number.length >= 4 ? row.account_number : null;
    if (!accountNumber) continue;
    const type = enumToken(row?.brokerage_account_type) || enumToken(row?.type) || "account";
    let label = `${masked(accountNumber)} ${type}`.trim();
    const count = (seen.get(label) ?? 0) + 1;
    seen.set(label, count);
    if (count > 1) label = `${label} (${count})`;
    out.push({ handle: handleFor(accountNumber), label, type, isDefault: row?.is_default === true,
      agenticTradingAllowed: row?.agentic_allowed === true,
      active: row?.deactivated !== true && row?.permanently_deactivated !== true });
  }
  if (!out.length) throw new Error("Accounts unavailable");
  return out;
}

/** Equity holdings, from `get_equity_positions`. A row whose symbol or share count cannot be read is dropped rather
 *  than guessed: a made-up holding is worse than a missing one, and the caller reports how many were dropped. */
export function normalizeHoldings(raw: unknown): { holdings: Holding[]; skipped: number; cursor: string | null } {
  const data = (raw as any)?.data;
  const rows = Array.isArray(data?.positions) ? data.positions : Array.isArray(data?.results) ? data.results : null;
  if (!rows) throw new Error("Positions unavailable");
  const holdings: Holding[] = [];
  let skipped = 0;
  for (const row of rows) {
    const symbol = typeof row?.symbol === "string" ? row.symbol.trim().toUpperCase() : "";
    const shares = number(row?.quantity ?? row?.shares);
    if (!SYMBOL.test(symbol) || shares === null) { skipped++; continue; }
    if (shares === 0) continue;                                   // a closed position is not a holding
    holdings.push({ symbol, shares, averageCost: positive(row?.average_buy_price ?? row?.average_cost ?? row?.cost_basis) });
  }
  const cursor = typeof data?.next_cursor === "string" ? data.next_cursor : typeof data?.cursor === "string" ? data.cursor : null;
  return { holdings, skipped, cursor };
}

/** The classes Robinhood reports a value for, in the order a reader thinks about them. Names are the provider's,
 *  taken from a captured payload rather than guessed — see the note on `normalizeTotals`. */
const VALUE_CLASSES = Object.freeze([
  ["equity_value", "Stocks"], ["options_value", "Options"], ["crypto_value", "Crypto"],
  ["futures_value", "Futures"], ["event_contracts_value", "Event contracts"],
  ["fixed_income_value", "Fixed income"], ["mutual_funds_value", "Mutual funds"],
] as const);

/** Account totals, from `get_portfolio`. A missing total is reported as unknown rather than computed from something
 *  that looked close.
 *
 *  The field names here are the ones the provider actually sends, captured from a live payload on 2026-09-16. They
 *  had to be: this function previously asked for `total_market_value`, `market_value`, `equity`, `total_equity`,
 *  `day_change`, `today_return`, `equity_change`, `total_return` and `total_return_amount` — and Robinhood sends
 *  none of them. Every report ever produced showed "Account value —". Only `cash` was right, by coincidence of
 *  naming. A guessed field name fails silently and indefinitely, which is why these are measured.
 *
 *  Note what is NOT accepted: `buying_power` is in the payload and was previously a fallback for cash. On a margin
 *  account it is roughly twice the cash, so that fallback stood ready to report borrowed money as money. */
export function normalizeTotals(raw: unknown): AccountTotals {
  const p = (raw as any)?.data?.portfolio ?? (raw as any)?.data ?? {};
  const byClass: { label: string; value: number }[] = [];
  for (const [key, label] of VALUE_CLASSES) {
    const v = number(p[key]);
    // Filtered at the precision it will be SHOWN at, not at exact zero. The page renders whole dollars, so a class
    // holding a tenth of a cent — crypto dust left after a sale — passed a `!== 0` test and then printed "$0": a line
    // asserting a class exists, at nothing. Half a dollar is the smallest value that does not round away.
    if (v !== null && Math.abs(v) >= 0.5) byClass.push({ label, value: v });
  }
  return { value: number(p.total_value), cash: number(p.cash), byClass };
}

/** Every holding in one account, following the provider's cursor. Bounded: a runaway page loop would burn the grant,
 *  and a truncated portfolio must say so rather than read as a complete one. */
/** The messages that mean the boundary itself refused, rather than a read failing. A call site that degrades on a
 *  failed read must let these past: an allowlist rejection or a closed connection at the only caller of a read that
 *  widened the boundary is precisely what must not be silent.
 *
 *  Both are also on ACCOUNT_SAFE_ERRORS, so rethrowing one reaches a user as itself. Rethrowing a message that set
 *  does not carry would cost the report AND flatten the signal to "Account read failed" — losing both things the
 *  rethrow exists for. */
export const BOUNDARY_ERRORS: ReadonlySet<string> = new Set([
  "Broker mutation or unsupported tool blocked",
  "Connect Robinhood market data first",
]);
/** The only messages the account path may show a user. Anything else a future call site throws is replaced, so a
 *  message that interpolates an account number or a payload cannot reach a transcript by being written carelessly.
 *  Safe by construction rather than safe because every call site today happens to be.
 *
 *  This is a claim about SAFETY, not a routing table: a message belongs here if showing it would disclose nothing,
 *  whether or not anything currently throws it. "Option positions unavailable" is on it and is, by design, caught
 *  before it reaches `sealed()` at today's only call site — it stays so the next call site that does rethrow it is
 *  not flattened into a generic failure. */
export const ACCOUNT_SAFE_ERRORS: ReadonlySet<string> = new Set([
  // Names the boundary's own refusal without naming the tool or the account: safe to show, and it must be, because
  // a call site that degrades on a read failure rethrows this rather than swallowing it.
  "Broker mutation or unsupported tool blocked",
  "Accounts unavailable",
  "Positions unavailable",
  // Carries no account number and no payload — the same shape as the line above it, for the option read.
  "Option positions unavailable",
  "Connect Robinhood market data first",
  "Robinhood account read failed; check connection status. No order was submitted.",
  "Robinhood did not grant account access to this connection. Reconnect with connect_robinhood to grant it, or carry on with market data.",
  "Unknown account. List the accounts first, then choose from that list.",
  "Choose between 1 and 20 accounts",
]);
/** Runs an account operation and lets only a known message out. */
export async function sealed<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) {
    const message = error instanceof Error ? error.message : "";
    throw new Error(ACCOUNT_SAFE_ERRORS.has(message) ? message : "Account read failed");
  }
}
/** One open option position. Every field is what the provider actually sends, captured 2026-09-16 — the shapes here
 *  were all guessed wrong before that capture, and each guess would have produced a confident wrong number:
 *
 *  - Direction is a `type` of `long`/`short`. Quantity stays POSITIVE. A normalizer written to read a negative
 *    quantity as a short would have booked every short as a long and inverted its profit and loss.
 *  - The field is `trade_value_multiplier` ("100.0000"), not `multiplier`. Hardcoding 100 is wrong for an adjusted
 *    contract and silently misprices it.
 *  - `average_price` is per SHARE. Cost per contract is `averageCostPerShare × multiplier`.
 *  - There is no strike and no call/put on the row at all. Both need a `get_option_instruments` lookup by
 *    `optionId`, which is market data and already allowed — so it is a later slice's work, not this one's. */
export interface OptionHolding {
  optionId: string;
  underlying: string;
  expiry: string;
  contracts: number;
  /** `null` when the row did not say which way round it is. The sign of both the market value and the P&L comes from
   *  here, so a contract without it cannot be valued — but it can still be named, counted and listed. */
  direction: "long" | "short" | null;
  /** Contracts-to-shares for the premium. `null` when unreadable — again a bar to valuing the contract, not to
   *  reporting that it is held. */
  multiplier: number | null;
  /** Average opening premium per quoted unit. `null` is "not given"; `0` is a verified zero basis. */
  averageCostPerShare: number | null;
  /** What could not be read on this row, when something could not. Its presence means: do not put a value on this
   *  contract. Its absence means every field needed for the arithmetic was there.
   *
   *  A row used to be dropped outright when any of these was missing, which left the graceful-failure path with
   *  nothing to rescue — a missing multiplier prevents VALUATION; it does not erase a known underlying, quantity and
   *  expiry. In a one-position account the difference is the whole report. */
  incomplete?: string[];
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A date that exists. The pattern alone accepts 2026-02-30 and 2026-13-45, and an expiry is not a decorative
 *  field — it is what tells a held contract from an expired one. */
const isDate = (s: string): boolean => {
  if (!DATE.test(s)) return false;
  const parsed = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === s;
};

/** Open option positions, rebuilt field by field like every other account read. A row that cannot be read as a
 *  position is dropped and counted rather than guessed: a made-up contract is worse than a missing one.
 *
 *  Closed positions come back too — one live account returned 750 rows, most of them long gone — so a zero quantity
 *  is skipped before anything else, exactly as a closed share position is. */
export function normalizeOptionHoldings(raw: unknown): { holdings: OptionHolding[]; skipped: number; cursor: string | null } {
  const data = (raw as any)?.data;
  const rows = Array.isArray(data?.positions) ? data.positions : Array.isArray(data?.results) ? data.results : null;
  if (!rows) throw new Error("Option positions unavailable");
  const holdings: OptionHolding[] = [];
  let skipped = 0;
  for (const row of rows) {
    const contracts = number(row?.quantity);
    if (contracts === null) { skipped++; continue; }
    if (contracts === 0) continue;                                   // a closed position is not a holding
    const optionId = typeof row?.option_id === "string" ? row.option_id : "";
    const underlying = typeof row?.chain_symbol === "string" ? row.chain_symbol.trim().toUpperCase() : "";
    const expiry = typeof row?.expiration_date === "string" ? row.expiration_date : "";
    // Identity. Without these a contract cannot be named, deduplicated against another account's copy of it, or
    // looked up — there is nothing to report, so the row is dropped and counted.
    if (!UUID.test(optionId) || !SYMBOL.test(underlying) || !isDate(expiry)) { skipped++; continue; }

    // Valuation. Each of these is load-bearing for a money figure and none of them is load-bearing for saying the
    // contract is held. Missing ones are named, and the contract is listed without a value rather than dropped.
    const incomplete: string[] = [];
    const direction = row?.type === "short" ? "short" : row?.type === "long" ? "long" : null;
    if (!direction) incomplete.push("direction");
    const multiplier = positive(row?.trade_value_multiplier);
    if (multiplier === null) incomplete.push("multiplier");
    // Robinhood reports a positive quantity and puts the direction in `type`, so a negative one means the two
    // disagree about something. Taking its absolute value turned that disagreement into a confident holding; it is
    // now reported, and the contract is not valued off a number whose convention is in doubt.
    if (contracts < 0) incomplete.push("quantity sign");

    holdings.push({ optionId, underlying, expiry, contracts: Math.abs(contracts), direction, multiplier,
      averageCostPerShare: nonNegative(row?.average_price),
      ...(incomplete.length ? { incomplete } : {}) });
  }
  const cursor = typeof data?.next === "string" ? data.next : typeof data?.next_cursor === "string" ? data.next_cursor : null;
  return { holdings, skipped, cursor };
}

export const MAX_POSITION_PAGES = 20;
/** Holdings charted per account. Every chart is a daily-bar read, so an account of a hundred names would otherwise
 *  spend a hundred provider calls on one report; the rest are listed with their cost and value, without levels. */
export const MAX_CHARTED_HOLDINGS = 20;
export async function readHoldings(broker: Pick<RobinhoodConnection, "accountRead">, accountNumber: string) {
  const holdings: Holding[] = [];
  let cursor: string | null = null, skipped = 0, pages = 0, truncated = false;
  do {
    const page = normalizeHoldings(await broker.accountRead("get_equity_positions",
      cursor ? { account_number: accountNumber, cursor } : { account_number: accountNumber }));
    holdings.push(...page.holdings); skipped += page.skipped; cursor = page.cursor;
    if (++pages >= MAX_POSITION_PAGES && cursor) { truncated = true; break; }
  } while (cursor);
  return { holdings, skipped, truncated };
}

/** Every open option position in one account. Same cursor discipline and the same page bound as shares.
 *
 *  The page bound was sized for share positions, and option rows are far more numerous — closed contracts come back
 *  alongside open ones, and one live account returned 750 in a single response. That is the reassuring part: the
 *  provider pages in hundreds, not tens, so twenty pages is thousands of rows. It is still bounded, and a truncated
 *  account still says so, because a portfolio that quietly stops short is worse than one that admits it. */
export async function readOptionHoldings(broker: Pick<RobinhoodConnection, "accountRead">, accountNumber: string) {
  const holdings: OptionHolding[] = [];
  let cursor: string | null = null, skipped = 0, pages = 0, truncated = false;
  do {
    const page = normalizeOptionHoldings(await broker.accountRead("get_option_positions",
      cursor ? { account_number: accountNumber, cursor } : { account_number: accountNumber }));
    holdings.push(...page.holdings); skipped += page.skipped; cursor = page.cursor;
    if (++pages >= MAX_POSITION_PAGES && cursor) { truncated = true; break; }
  } while (cursor);
  return { holdings, skipped, truncated };
}

/** A contract's terms. The strike and the right live here, not on the position — they are looked up by `option_id`.
 *
 *  ⚠️ `type` means two different things across the two objects and they are merged: on a POSITION it is
 *  `long`/`short`, on an INSTRUMENT it is `call`/`put`. Each is mapped to its own name at the boundary —
 *  `direction` and `right` — and a bare `type` never travels past this normalizer. Overwriting one with the other
 *  loses the direction, and a lost direction inverts a short's profit and loss. */
export interface OptionInstrument {
  optionId: string;
  strike: number;
  right: "call" | "put";
  /** The chain the contract belongs to, which is not always the underlying's own symbol. */
  chainSymbol: string;
  multiplier: number | null;
  underlyingType: string;
}

/** Why this contract's strike may NOT be drawn against the underlying's price axis, or null when it may.
 *
 *  Anything suggesting the deliverable is not the standard 100 shares withholds the marker. **A multiplier of 100
 *  is not proof that it is**: an OCC adjustment after a reverse split can leave strike $5 and multiplier 100 while
 *  the deliverable becomes 10 shares — exercise costs $500 and the stock must clear $50, so a "$5" line drawn
 *  against a $6 stock states the opposite of the truth.
 *
 *  This payload does not carry the deliverable, so standard terms cannot be *verified* here, only contradicted. The
 *  rule is conservative for that reason: every available signal must look ordinary, and anything missing or unusual
 *  withholds the marker. The strike still appears in the row — it simply is not drawn as though comparable. */
export function strikeNotComparable(instrument: OptionInstrument, underlying: string): string | null {
  if (instrument.multiplier !== 100) return "a non-standard contract multiplier";
  // An adjustment generally opens a new chain whose symbol carries a suffix (NVDA1), so a chain symbol that is not
  // the underlying's own is the one hint in this payload that the terms may have been adjusted.
  if (instrument.chainSymbol !== underlying) return `it trades in the ${instrument.chainSymbol} chain, not ${underlying}`;
  if (instrument.underlyingType && instrument.underlyingType !== "equity") return `its underlying is ${instrument.underlyingType}, not an equity`;
  return null;
}

export function normalizeOptionInstruments(raw: unknown): { instruments: OptionInstrument[]; skipped: number } {
  const data = (raw as any)?.data;
  const rows = Array.isArray(data?.instruments) ? data.instruments : Array.isArray(data?.results) ? data.results : null;
  if (!rows) throw new Error("Option instruments unavailable");
  const instruments: OptionInstrument[] = [];
  let skipped = 0;
  for (const row of rows) {
    const optionId = typeof row?.id === "string" ? row.id : "";
    const strike = positive(row?.strike_price);
    const right = row?.type === "call" ? "call" : row?.type === "put" ? "put" : null;
    // Strike and right are the whole reason for this call. A row without them identifies nothing, and a contract
    // with no instrument is rendered from what its position already knows rather than from a guess.
    if (!UUID.test(optionId) || strike === null || !right) { skipped++; continue; }
    instruments.push({ optionId, strike, right,
      chainSymbol: typeof row?.chain_symbol === "string" ? row.chain_symbol.trim().toUpperCase() : "",
      multiplier: positive(row?.trade_value_multiplier),
      underlyingType: typeof row?.underlying_type === "string" ? row.underlying_type.trim().toLowerCase() : "" });
  }
  return { instruments, skipped };
}

/** Identifying contracts is its own budget, not a share of the charting one.
 *
 *  Tying the two together was the central mistake in the first version of this slice: strike and call/put are basic
 *  inventory fields, so a contract on the twenty-first underlying would have carried no strike even with a
 *  perfectly working lookup — the founder's own complaint, one cap away. Nothing here truncates the positions
 *  already read; a limit reached means some contracts are listed without their terms, and the page says which
 *  limit it was. */
export const MAX_INSTRUMENT_IDS = 200;
export const INSTRUMENT_BATCH = 25;
/** One underlying can carry hundreds of distinct strikes and expirations, so a per-underlying bound is no bound at
 *  all on the calls: if the provider turns out not to parse a comma-separated list, every id falls back to its own
 *  request. This caps that fallback rather than discovering the ceiling in production. */
export const MAX_INSTRUMENT_RETRIES = 60;

export interface InstrumentLookup {
  found: Map<string, OptionInstrument>;
  /** Asked for and not returned, after the individual retries. These are listed without their terms. */
  missing: Set<string>;
  /** Never asked about, because a budget ran out first. A different sentence from `missing`: one is the provider
   *  declining to answer, the other is this report declining to ask. */
  unasked: Set<string>;
}

/** Look contracts up by id, in batches, reconciling what came back against what was asked for.
 *
 *  **Reconcile by id, never by row count.** A response can hold the count steady while missing a requested contract
 *  — a duplicate row, or an id neither asked for nor expected — and a count check would call that a complete answer.
 *
 *  Comma-separation is not proven: the only live evidence is `{ids: "a,a"}` returning one row, which is consistent
 *  with the comma being parsed and equally with the whole string being treated as a single id that matched nothing.
 *  The reconcile-and-retry shape is correct either way and self-heals if the provider changes. `cache` is carried
 *  across accounts for the life of one report, because the same contract can be held in two of them, and it
 *  remembers failures as well as successes so an unavailable contract is not paid for twice. */
export async function readOptionInstruments(
  broker: Pick<RobinhoodConnection, "read">,
  ids: readonly string[],
  cache: Map<string, OptionInstrument | null> = new Map(),
): Promise<InstrumentLookup> {
  const found = new Map<string, OptionInstrument>(), missing = new Set<string>(), unasked = new Set<string>();
  const wanted: string[] = [];
  for (const id of new Set(ids)) {
    if (!cache.has(id)) { wanted.push(id); continue; }
    const hit = cache.get(id)!;
    if (hit) found.set(id, hit); else missing.add(id);
  }
  // Over budget: ask about as many as it allows and name the rest as unasked, rather than either dropping them
  // silently or spending an unbounded number of calls on one report.
  const ask = wanted.slice(0, MAX_INSTRUMENT_IDS);
  for (const id of wanted.slice(MAX_INSTRUMENT_IDS)) unasked.add(id);

  const outstanding: string[] = [];
  for (let i = 0; i < ask.length; i += INSTRUMENT_BATCH) {
    const batch = ask.slice(i, i + INSTRUMENT_BATCH);
    try {
      const { instruments } = normalizeOptionInstruments(await broker.read("get_option_instruments", { ids: batch.join(",") }));
      const back = new Map(instruments.map(x => [x.optionId, x]));
      for (const id of batch) {
        const hit = back.get(id);
        if (hit) { found.set(id, hit); cache.set(id, hit); } else outstanding.push(id);
      }
    } catch {
      // A whole batch failing says nothing about the individual contracts in it — the retry pass decides that.
      outstanding.push(...batch);
    }
  }

  let retries = 0;
  for (const id of outstanding) {
    if (retries >= MAX_INSTRUMENT_RETRIES) { unasked.add(id); continue; }
    retries++;
    try {
      const { instruments } = normalizeOptionInstruments(await broker.read("get_option_instruments", { ids: id }));
      const hit = instruments.find(x => x.optionId === id);
      if (hit) { found.set(id, hit); cache.set(id, hit); } else { missing.add(id); cache.set(id, null); }
    } catch { missing.add(id); cache.set(id, null); }
  }
  return { found, missing, unasked };
}

/** What a held contract is worth and what it has made, with the sign in the right places.
 *
 *  "Invert the P&L for a short" is not enough to build from, and was the instruction this replaced: the sign has to
 *  reach the market VALUE too. A short's position is a liability — closing it costs money — so its market value is
 *  negative. Correct P&L beside a positive short value still overstates the account by twice the premium.
 *
 *  With `q` the contract count, `m` the premium multiplier, `a` the average opening premium per quoted unit, `p` the
 *  current mark, and `s` = +1 long / −1 short:
 *
 *      value = s·q·m·p        basis = s·q·m·a        gain = s·q·m·(p − a)
 *
 *  Four contracts opened at $6.20 and marked $7.85 at multiplier 100: the long is $3,140 and +$660; the short is
 *  −$3,140 and −$660, against $2,480 of opening credit.
 *
 *  Returns null when the contract cannot be valued rather than valuing it wrongly — an unknown direction or
 *  multiplier, or no mark. The contract is still listed; it simply carries no money figure. */
export interface OptionValuation {
  /** Signed. Negative for a short position, which is an obligation and not an asset. */
  value: number;
  /** Signed opening premium. Negative for a short: a credit received, not an amount paid. */
  basis: number | null;
  gain: number | null;
  /** Gain as a percentage **of the opening premium** — which is neither return on collateral nor return on capital,
   *  and must be labelled for what it is wherever it is shown. Divided by the ABSOLUTE basis: dividing a short's
   *  gain by its negative signed basis reverses the sign and reports a profit as a loss. Null for a zero basis,
   *  where a dollar gain is meaningful and a percentage is not. */
  gainPctOfPremium: number | null;
}
export function valueOption(holding: OptionHolding, mark: number | null): OptionValuation | null {
  const { direction, multiplier, contracts, averageCostPerShare: a } = holding;
  if (holding.incomplete?.length || !direction || multiplier === null || mark === null) return null;
  const sign = direction === "short" ? -1 : 1;
  const units = contracts * multiplier;
  const value = sign * units * mark;
  if (a === null) return { value, basis: null, gain: null, gainPctOfPremium: null };
  const basis = sign * units * a;
  const gain = sign * units * (mark - a);
  return { value, basis, gain, gainPctOfPremium: a === 0 ? null : gain / Math.abs(basis) * 100 };
}
