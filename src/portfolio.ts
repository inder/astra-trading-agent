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
export interface AccountTotals { value: number | null; cash: number | null; dayChange: number | null; totalReturn: number | null }

const SYMBOL = /^[A-Z][A-Z0-9.-]{0,9}$/;
const text = (v: unknown, max = 40) => typeof v === "string" && v.length <= max && /^[\w .,'()\/-]*$/.test(v) ? v : "";
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
    const type = text(row?.brokerage_account_type) || text(row?.type) || "account";
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

/** Account totals, from `get_portfolio`. Every field is optional: a missing total is reported as unknown rather than
 *  computed from something that looked close. */
export function normalizeTotals(raw: unknown): AccountTotals {
  const p = (raw as any)?.data?.portfolio ?? (raw as any)?.data ?? {};
  return { value: number(p.total_market_value ?? p.market_value ?? p.equity ?? p.total_equity),
    cash: number(p.cash ?? p.buying_power ?? p.total_cash),
    dayChange: number(p.day_change ?? p.today_return ?? p.equity_change),
    totalReturn: number(p.total_return ?? p.total_return_amount) };
}

/** Every holding in one account, following the provider's cursor. Bounded: a runaway page loop would burn the grant,
 *  and a truncated portfolio must say so rather than read as a complete one. */
export const MAX_POSITION_PAGES = 20;
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
