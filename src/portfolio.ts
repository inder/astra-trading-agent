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
/** The only messages the account path may show a user. Anything else a future call site throws is replaced, so a
 *  message that interpolates an account number or a payload cannot reach a transcript by being written carelessly.
 *  Safe by construction rather than safe because every call site today happens to be. */
export const ACCOUNT_SAFE_ERRORS: ReadonlySet<string> = new Set([
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
  direction: "long" | "short";
  contracts: number;
  expiry: string;
  averageCostPerShare: number | null;
  multiplier: number;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

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
    const direction = row?.type === "short" ? "short" : row?.type === "long" ? "long" : null;
    const multiplier = positive(row?.trade_value_multiplier);
    // Every one of these is load-bearing for a money figure, so a row missing any of them is dropped rather than
    // defaulted. A contract of unknown direction or unknown multiplier cannot be valued, only guessed at.
    if (!UUID.test(optionId) || !SYMBOL.test(underlying) || !DATE.test(expiry) || !direction || multiplier === null) {
      skipped++; continue;
    }
    holdings.push({ optionId, underlying, direction, contracts: Math.abs(contracts), expiry,
      averageCostPerShare: positive(row?.average_price), multiplier });
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
