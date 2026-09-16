# Readiness — version 0.4

The local end-to-end PAPER workflow is implemented: credential-free discovery,
configuration, independent browser authorization, continuously scheduled runs,
option selection, assumed fills, positions and estimated P&L, reviewed trims/
closes, durable history, stop and explicit management-only recovery.

Two read-only surfaces sit beside it. `get_levels` answers where a stock's support
and resistance are, from daily or weekly bars. `get_portfolio_report` reads the
accounts the user names — balances and equity positions — and writes a printable
report of what they hold with those levels around each holding, served on loopback.
Both are advisory, and neither can reach a tool that places an order.

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

For the account path, tests assert that every one of the 73 tools Robinhood's scope
granted is refused except the nine on the allowlists, that provider text and hostile
account-type strings cannot reach the model or the page, that a malformed holding is
dropped and counted rather than guessed, and that an error names no account. For the
report: that it lands only under the data directory at mode `0600`, that a second
report is a second file, that one stock held in two accounts gets independent
charts, that the loopback server serves only names it minted and refuses a
cross-origin or non-GET request, that two concurrent reports share one listener, and
that the policy the server sends admits the script the page pins. Account data in
these tests is invented; no real account is read by the suite.

## Attended acceptance gate

After installation, follow [the full walkthrough](PAPER-WORKFLOW.md). The owner
must approve Robinhood in a browser, verify required tools, then verify
market-hours history and fresh option/equity quotes during a paper session.
The authenticated production path has NOT been exercised by automated tests.
The chosen chat application's MCP setup also needs an owner acceptance test.
No real-account readiness or trading performance is claimed.

## Known limits

- Trading is PAPER only: no real orders and no live flag. Real accounts are read,
  but only read — balances and equity positions, when asked, for the portfolio
  report. Its profit and loss is unrealized and covers equities held now; realized
  P&L, transaction history and account-wide return are not read.
- Assumed ask/bid fills, no execution guarantees, partial fills or actual fees.
  P&L excludes fees; missing marks are unavailable, never zero-valued marks.
- Polling (default one second) is not streaming. Latency and the freshness/gap
  settings (default five seconds) can conservatively skip entries; unseen crossings
  remain possible. Option catalogs load before 9:32 and an entry quotes only the
  nearest strikes, so entries are one stock quote plus one to three option-quote
  requests; a catalog that has to load at the entry instead can still hold up
  polling past the gap, which drops the other stocks still being watched, honestly.
  Strikes listed during the day are not in the morning catalog. The stock quote an
  entry ranks strikes by is taken once, so by a third batch it is a few seconds old.
- A single failed read is only counted; two in a row are a journaled data gap, not a halt; sustained failures
  (default 60 s) halt, except that open positions keep being managed on option
  prices through an equity-quote outage. An option-price outage alone never halts:
  exits wait for a fresh bid and anything unsold at the close is written off.
- Memory-only tokens: restart needs authorization and explicit recovery.
  Recovery makes no new entries after a monitoring gap.
- A running local process is required. HTTP can outlive chat connections; stdio
  follows its client. No launch daemon, cloud hosting or public client OAuth.
- Strategy 0.9.0 keeps watching a stock whose entry quote no longer confirms the
  breakout, up to `maxEntryAttempts` (0.8.0 prefetched option catalogs and
  journaled on change; 0.7.0 made market-data timing configurable; 0.6.0 replaced
  the stock-gain trims with option-price targets). Paper runs configured under an
  earlier version cannot resume or be reconfigured under the same runId; configure
  a new runId.
- Calendar covers 2026–2027 with NYSE holidays/early closes. No automatic rollover;
  after session end a stopped run can only be settled (unsold contracts written off).
- Contracts with no fresh bid by the close are written off at -100%. No invented
  liquidation price, exercise or overnight management.
- Single owner, one run per strategy/date, no account sharing or multi-tenancy.
- Journals hold decisions plus a heartbeat a minute (a few hundred revisions a day);
  no automatic retention/deletion. Keep data private.
- License selection is pending. Public source alone is not an open-source
  license; package publication remains disabled pending release review.

SignalDeck's private experiments, processes, credentials and history stay outside
this distribution. Development never submits actual brokerage orders.
