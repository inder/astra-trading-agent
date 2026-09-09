# Paper-workflow readiness — version 0.3

The local end-to-end PAPER workflow is implemented: credential-free discovery,
configuration, independent browser authorization, continuously scheduled runs,
option selection, assumed fills, positions and estimated P&L, reviewed trims/
closes, durable history, stop and explicit management-only recovery.

## Evidence

The automated suite exercises real MCP over stdio and authenticated loopback
HTTP, plus an MCP-client paper scenario from setup through browser-reviewed close
and journal inspection. SDK OAuth discovery, registration, PKCE, callback security
and tool checks use mocked provider responses. Continuous market-data and
simulated entry, marking, trim and exit tests also use invented data.

Checks cover both entry setups, optional premarket history, whole-contract sizing,
fee reserves and two-name/session limits, duplicate ownership, no budget recycling,
stale/future/foreign data, deferred protective exits surviving rebounds/restarts,
provider failure, revisions, recovery, session/early-close handling, and unresolved
exits remaining visible at close. A timer test verifies progress without a chat
client driving each tick. CI repeats typecheck and tests on Node 24 and 26.

## Attended acceptance gate

After installation, follow [the full walkthrough](PAPER-WORKFLOW.md). The owner
must approve Robinhood in a browser, verify required tools, then verify
market-hours history and fresh option/equity quotes during a paper session.
The authenticated production path has NOT been exercised by automated tests.
The chosen chat application's MCP setup also needs an owner acceptance test.
No real-account readiness or trading performance is claimed.

## Known limits

- PAPER only: no real orders, live flag, account holdings or account-wide P&L.
- Assumed ask/bid fills, no execution guarantees, partial fills or actual fees.
  P&L excludes fees; missing marks are unavailable, never zero-valued marks.
- Target one-second polling is not streaming. Latency and five-second freshness/
  gap checks can conservatively skip entries; unseen crossings remain possible.
- Memory-only tokens: restart needs authorization and explicit recovery.
  Recovery makes no new entries after a monitoring gap.
- A running local process is required. HTTP can outlive chat connections; stdio
  follows its client. No launch daemon, cloud hosting or public client OAuth.
- Calendar supports 2026 with known holidays/early closes. No automatic rollover
  or recovery after session end.
- Missing exit quotes leave unresolved paper positions visible. No invented
  liquidation, exercise or overnight management.
- Single owner, one run per strategy/date, no account sharing or multi-tenancy.
- Journals grow during runs; no automatic retention/deletion. Keep data private.
- License selection is pending. Public source alone is not an open-source
  license; package publication remains disabled pending release review.

SignalDeck's private experiments, processes, credentials and history stay outside
this distribution. Development never submits actual brokerage orders.
