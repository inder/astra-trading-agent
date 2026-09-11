# Paper-workflow readiness — version 0.3

The local end-to-end PAPER workflow is implemented: credential-free discovery,
configuration, independent browser authorization, continuously scheduled runs,
option selection, assumed fills, positions and estimated P&L, reviewed trims/
closes, durable history, stop and explicit management-only recovery.

## Evidence

Agent-guided installation is documented in the root INSTALL.md, linked from the
README, AGENTS.md and CLAUDE.md. The setup helper is tested against an isolated
real MCP process and emits local client settings without modifying them. Actual
registration/reload in a user's chat application remains an installation check,
not something the helper claims to have done.

The automated suite exercises real MCP over stdio and authenticated loopback
HTTP, plus an MCP-client paper scenario from setup through browser-reviewed close
and journal inspection. SDK OAuth discovery, registration, PKCE, callback security
and tool checks use mocked provider responses. Continuous market-data and
simulated entry, marking, trim and exit tests also use invented data.

Checks cover the opening-range setup, optional premarket history, whole-contract
sizing, fee reserves and two-name/session limits, duplicate ownership, no budget
recycling, stale/future/foreign data, the 2×/3×/5× option targets, breakeven, the
simulated 50% backstop, deferred exits surviving rebounds/restarts, provider
failure, revisions, recovery, session/early-close handling, and write-off of
contracts that cannot be sold before the close. A timer test verifies progress without a chat
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
- Polling (default one second) is not streaming. Latency and the freshness/gap
  settings (default five seconds) can conservatively skip entries; unseen crossings
  remain possible. A slow entry that holds up polling past the gap drops the other
  stocks still being watched, honestly; faster entries arrive in the next slice.
- A single failed read is a journaled data gap, not a halt; sustained failures
  (default 60 s) halt, except that open positions keep being managed on option
  prices through an equity-quote outage.
- Memory-only tokens: restart needs authorization and explicit recovery.
  Recovery makes no new entries after a monitoring gap.
- A running local process is required. HTTP can outlive chat connections; stdio
  follows its client. No launch daemon, cloud hosting or public client OAuth.
- Strategy 0.7.0 made market-data timing configurable (0.6.0 replaced the
  stock-gain trims with option-price targets). Paper runs configured under an
  earlier version cannot resume or be reconfigured under the same runId; configure
  a new runId.
- Calendar covers 2026–2027 with NYSE holidays/early closes. No automatic rollover;
  after session end a stopped run can only be settled (unsold contracts written off).
- Contracts with no fresh bid by the close are written off at -100%. No invented
  liquidation price, exercise or overnight management.
- Single owner, one run per strategy/date, no account sharing or multi-tenancy.
- Journals grow during runs; no automatic retention/deletion. Keep data private.
- License selection is pending. Public source alone is not an open-source
  license; package publication remains disabled pending release review.

SignalDeck's private experiments, processes, credentials and history stay outside
this distribution. Development never submits actual brokerage orders.
