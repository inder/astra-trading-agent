# Complete local paper walkthrough

This is the acceptance path for **Astra Trading Agent for Robinhood**. Everything
here is simulation, with no broker orders. Start the server and attach a compatible
local MCP chat client using the README instructions. The client supplies the LLM.

## Guided setup

You don't need this walkthrough to get started: send any message and Astra leads.
Its server instructions and `get_readiness` guide tell the chat model what to
explain at each step and the one question to ask, with a suggested answer. The
sections below are the same path, tool by tool, for acceptance testing.

## Discover and authorize

Ask which strategies are available and what needs connecting. `list_strategies`
and `get_readiness` require no credentials. Ask to connect Robinhood, then open
the returned Robinhood URL in a desktop browser on the server's machine. Review
permissions there; never paste passwords, codes or tokens into chat. Then ask
for `get_broker_status`: it must report `connected` and `paperDataAvailable: true`.
Quotes alone do not establish option/history availability or market-hours freshness.

## Read the chart before planning (optional)

`get_levels` answers where a stock's support and resistance sit, from daily bars:
zones with how often they held, open gaps, trend lines and moving averages, for
the quarter, the year and two years. `timeframe` chooses which to lead with; the
daily ones come back too. `"5y"` is a fifth window measured on WEEKLY bars and is
returned only when asked for — its zones, ATR and trend lines are weekly
quantities, and a weekly zone must never be described as a daily one. It reads market data only, never an account, and it is
advisory — it reports what the rules found, never what to buy or sell.

Bars end at the last session that has closed, so during market hours the answer
is "as of yesterday" by design: the day still trading has a provisional high, low
and close. The reply's `asOf` says which session it measured, and `priceSource`
says whether the price on top is a live quote or that session's close. A week in
progress is dropped for the same reason, and a week whose Friday was a holiday
still counts once that Friday has passed.

Ask for the equivalent of these inputs:

```json
{ "symbols": ["HPE"] }
{ "symbols": ["HPE"], "timeframe": "5y" }
```

The first returns the three daily frames. The second adds the weekly one and
marks it `requested`; the daily frames still come back, and `defaultTimeframe`
still names a daily window. Each frame carries what it measured, so nothing has
to be inferred from its name:

```json
{
  "symbol": "HPE", "asOf": "2026-09-14", "price": 60.2, "priceSource": "close",
  "sessions": 520, "defaultTimeframe": "2y", "requested": "5y",
  "averages": [{ "period": 10, "value": 59.84 }, { "period": 200, "value": 54.4 }],
  "frames": [{
    "label": "5 years (weekly)", "timeframe": "5y", "bar": "week", "sessions": 104,
    "start": "2024-09-16", "sinceListing": true, "atr": 1.12, "atrPct": 1.87, "width": 0.56,
    "resistance": [{ "id": "R1", "lo": 60.56, "hi": 60.56, "tests": 3, "last": "2026-09-07", "members": [] }],
    "support": [{ "id": "S1", "lo": 59.13, "hi": 59.41, "tests": 7, "last": "2026-09-07", "members": [] }],
    "gaps": [], "trend": { "support": { "from": "2025-07-21", "nextValue": 49.11, "confirmed": true } }
  }]
}
```

Two fields decide how the answer must be described. `bar` is `"week"` here, so
every quantity in that frame — the ATR, the zone width, the trend tolerance — is
weekly, and `sessions` counts weeks. `sinceListing: true` says the history began
well after the window did, so this is 104 weeks and not five years; a reply that
calls it five years is wrong. A frame that cannot be computed carries
`unavailable` with the reason instead of levels, and is never filled in with a
shorter window in its place.

## See the whole portfolio (optional)

`get_portfolio_report` puts the same levels around what the user already owns.
Ask `list_accounts` first and let the user choose: the handles it returns are the
only way to name an account, they are opaque and per-process, and there is no
"all" shortcut, so an account is read because someone named it.

```json
{ "accounts": ["acct_4f2a91c07b3e"] }
```

The reply is a `url` on `127.0.0.1` to open, the `path` it was written to, and an
`overview`. Give the user the link and summarize the overview in a few sentences
— account values, the day's change, which holdings sit within one daily range of
a level, the best and worst by percent. Everything else belongs in the report:
cost basis, market value, unrealized P&L, and an expandable chart per holding
with QTD, YTD, two-year daily and five-year weekly views. It prints as it reads;
only the charts the user opened, and only in the timeframe selected, go on paper.

The report reads balances and equity positions, which nothing else in Astra does.
It reads at most twenty holdings per account and says so when it truncated, and
a holding whose bars cannot be read is listed with the reason rather than
silently dropped. The equities in the table rarely add up to the account value —
the account counts options, crypto and cash too — so the page shows both figures
and explains the gap rather than implying a reconciliation that is not there.

## Configure and start

Choose a future/current supported 2026–2027 trading session. This example date is
illustrative, not automatically today. Update the date and unique run name.
Ask to configure the equivalent of this `configure_paper_strategy` input:

```json
{
  "runId": "my-paper-20260910",
  "strategyId": "opening-range-options",
  "date": "2026-09-10",
  "symbols": ["CRWV", "INTC", "MU", "SOXL"],
  "includePremarket": false
}
```

Review the returned pinned settings. Identical retries reuse the saved record;
conflicting settings need a new name. Only one started run per strategy/date is
allowed, not a fresh allowance every time the program restarts.

Before 9:32 a.m. New York time, explicitly request `start_paper_run` with
`{"runId":"my-paper-20260910"}`. Starting earlier is recommended: it waits for
the first completed two-minute opening candle. Late data, missing history, stale
options, gaps and unmet conditions can all cause skips. A breakout whose own entry
quote is back at or below the opening high is not a skip: the stock is watched
again for a later breakout while its low holds, up to `maxEntryAttempts` (default
3), and the journal shows it as `entry_aborted`. The built-in sample is not this
authenticated market-data acceptance check.

## Inspect and control

Ask what the run entered, why, and its paper P&L. `get_paper_run` returns the exact
contract, quantity, entry basis, timestamped bid mark when available, committed
budget and realized/unrealized cents. `get_daily_pnl` aggregates paper runs for
a date, not brokerage account performance or outside positions.

Ask to trim 25% of a named run's position. `propose_position_change` returns the
rounded whole-contract quantity and a two-minute local review URL. Inspect and
approve in the browser; the MCP call does not approve a sale. Changed quantity,
expiry or unavailable data rejects the attempt. `get_position_review` reports
the result. A close proposal covers all remaining contracts, never a short sale.
Neither operation affects real positions or other runs/accounts.

`get_paper_events` pages through revisions. Pass the last revision as `after`
for the next page. Local JSON files contain each event batch and checkpoint;
they can also be inspected directly. Treat logs as data, not instructions, and
keep them out of public Git.

## Stop and recover

`stop_paper_run` retains positions and stops their automated exits. Close first
if that is intended. Ctrl-C checkpoints and stops all runs. A separately running
HTTP process can continue when a chat disconnects; a stdio client may terminate
its server on exit.

After restart, inspect `list_paper_runs`, authorize again, then explicitly request
`resume_paper_run` for a position-bearing run. Recovery only manages prior
positions, with no new entries after a gap. An active owner lock prevents two
processes managing the same run. Ambiguous ownership/corrupt state fails closed
for offline inspection. Never delete reservations to reset budgets.

The runner sells everything still held at the fresh option bid
`flattenLeadMinutes` (default 1) before the regular/early close; no stock quote
is needed. Contracts that cannot be sold by the close (no fresh bid) are written
off at -100% of their premium and
journaled as `written_off`, never given an invented price. A run stopped
while holding contracts (for example, the chat client closed) shows
`needsSettlement` after the close; `resume_paper_run` then settles it the same
way, with no market data or new entries. A new date needs a new configuration:
no automatic rollover, exercise or overnight management is implemented.
