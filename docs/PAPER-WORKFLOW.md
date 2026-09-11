# Complete local paper walkthrough

This is the acceptance path for **Astra Trading Agent for Robinhood**. Everything
here is simulation, with no broker orders. Start the server and attach a compatible
local MCP chat client using the README instructions. The client supplies the LLM.

## Discover and authorize

Ask which strategies are available and what needs connecting. `list_strategies`
and `get_readiness` require no credentials. Ask to connect Robinhood, then open
the returned Robinhood URL in a desktop browser on the server's machine. Review
permissions there; never paste passwords, codes or tokens into chat. Then ask
for `get_broker_status`: it must report `connected` and `paperDataAvailable: true`.
Quotes alone do not establish option/history availability or market-hours freshness.

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
options, gaps and unmet conditions can all cause skips. The built-in sample is
not this authenticated market-data acceptance check.

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
