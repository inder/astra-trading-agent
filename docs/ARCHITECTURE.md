# Architecture

Astra Trading Agent for Robinhood is one shared framework, not a separate chat
implementation for each bot. The local MCP-compatible client supplies the LLM.

```text
Chat client → MCP adapter → TradingAgentService
                            ├─ registry → sample adapters
                            ├─ PaperController → strategy PaperRuntime
                            │                     └─ PaperMarket → Robinhood reads
                            ├─ PaperReviews → local browser → serialized control
                            ├─ levels engine → daily bars → Robinhood reads
                            └─ immutable event/checkpoint journal
```

The MCP layer owns tool schemas, not strategy logic. The service owns the shared
controller, reviews and brokerage lifetime. The broker adapter owns independent
OAuth/PKCE and memory-only tokens. The market adapter maps bounded data requests
to allowlisted reads. No component needs a model key or copies Codex credentials.

## Adding a strategy

Implement `AgentStrategy`: stable ID/version, capabilities, validated preview,
synthetic adapter, and optional `paperFactory`. The factory returns a
`PaperRuntime` with `step`, `control`, `checkpoint`, and normalized `view`.
Register it in `agentStrategies`; do not add strategy-specific chat parsing.
The initial implementation is `orb-paper-runtime.ts`, with the deterministic
engine in `orb-options.ts` and supported settings in `orb-config.ts`.

Runtime adapters do not own credentials, transports, scheduling, approval or
file paths. The common controller owns lifecycle boundaries. The current setup
schema is equity-session-oriented (date, symbols, optional premarket). Strategies
needing other parameters require a versioned schema extension, not an executable
payload. The calendar is NY equity sessions in 2026–2027; other markets need explicit
support and tests. No uploads, generated code or shell commands are exposed.

Each strategy must test inputs, entry/exit invariants, budgets, recovery, stale
data, idempotency and a synthetic full-workflow example. Publishing never changes
the pinned version/configuration of an existing run.

## Levels

`levels.ts` is a pure function over daily bars: swing pivots, ATR-sized zones and
their tests, open gaps, trend lines and moving averages, per timeframe. It holds
no state, reads nothing, and is advisory — it describes what the rules found and
never what to do. It is a port of a prototype validated by eye; the differences
from it are listed in `DIVERGENCES` in the file, and parity is pinned by a golden
fixture in `test/fixtures/levels-golden.json`.

Every number it uses is a validated setting with a default and bounds
(`LEVELS_SETTINGS`), on the same rule as strategy configuration: no magic numbers.

Weekly is the same code over different bars, not a second implementation:
`aggregateWeekly` folds daily bars into weeks dated by their Monday, and the
window runs through `analyzeWindow` unchanged. Two consequences are deliberate.
A weekly frame's ATR, zone width and trend tolerance are weekly quantities, so
`Frame.bar` says which bars a frame measured and `sessions` counts weeks. And a
week still trading is dropped, exactly as the session still trading is: a
provisional bar never becomes a level. Weekly is never the default timeframe —
it would win by being the longest — and is returned only when asked for.

The service owns everything the engine refuses to: fetching bars split-adjusted,
rejecting a history that is incomplete, interpolated, duplicated or out of order,
and caching one read per stock per settled session. Bars are kept only through the
last session that has **closed** — the provider returns the session still trading,
and a provisional high, low and close must never be measured or cached as a
completed bar. A stock whose history cannot be read is named in the answer; the
others still answer.

## Accounts and the portfolio report

Account reads are a second allowlist, not an extension of the first. `ACCOUNT_READS`
(`get_accounts`, `get_portfolio`, `get_equity_positions`) has its own accessor
beside `MARKET_READS`, so widening the market-data path cannot widen the account
path by accident, and a startup check refuses to run if either list ever names a
mutation. Robinhood's single scope grants 73 tools, order placement included;
these nine are the whole boundary.

`portfolio.ts` is the trust edge. Every account response is rebuilt field by field
from an allowlist rather than filtered, so provider text nobody asked for — the
`guide` string Robinhood returns with account reads among it — never reaches the
model or the page. An account's type must match a closed vocabulary of ordinary
words, because a free-text field beside a masked account number is an injection
channel. A holding whose symbol or share count cannot be read is dropped and
counted, never guessed: a made-up holding is worse than a missing one. Errors leave
this path through `sealed()`, which replaces any message not on a short list, so a
message interpolating an account number cannot reach a transcript by being written
carelessly.

Account numbers never enter the chat. Callers hold a handle that is random for this
process, forgotten when it exits, and invalidated on reconnect — a reconnect may be
a different Robinhood login, so handles minted under the previous one must not
resolve. There is no "all accounts" shortcut: an account is read because someone
named it.

`report.ts` is a pure function from accounts to one self-contained HTML page: no
network, no fonts, no library, one inline script pinned by hash in the page's own
policy. Charts are SVG drawn from the same `levels` output the table quotes, so
the drawn line and the stated number cannot disagree. `report-server.ts` serves
written reports on loopback, because a file path is readable by a chat client only
inside its own working directory and that directory moves; a URL has no such rule.
It is not a file server — a name it did not mint is not served, so a traversal has
nothing to traverse to — and its policy is the page's own, because a browser
enforces every policy it is given and a stricter header would silently forbid the
script the page pins.

The report file is the one place account data is written down: one file, mode
`0600`, under the data directory, at a path settled at construction rather than
passed per call. It is never journalled, logged or checkpointed. Bars are cached
because they are market data; nothing about an account is.

## Transactions and recovery

Configuration does not start itself. An explicit start reserves the strategy/date
and acquires exclusive local ownership. Timer ticks and user controls share a
serialized queue. Each complete simulated transaction publishes its events and
checkpoint together. A failed tick discards uncommitted in-memory simulation.
This model is PAPER-only: real orders would need external reconciliation and
order idempotency, because external side effects cannot be rolled back this way.

Stopping retains positions. Restart does not auto-run anything; explicit recovery
manages prior positions only, never makes new entries after a gap. Shutdown
closes review intake, stops/checkpoints runs and disconnects the broker. A separate
HTTP process survives chat disconnects; client-owned stdio may stop with its client.
The local ownership-acquisition guard serializes dead-owner recovery; a crash
inside that short critical section fails closed for offline inspection.

## Reviewed paper controls

A proposal binds run, symbol, action, exact rounded quantity, expected remaining
quantity and a two-minute expiration. Browser approval requires a separate cookie,
form token, exact loopback origin/host, and single use. Execution rechecks position
state and fresh data inside the strategy queue. It cannot affect another run or
actual account holdings. This is not a real-trade authorization system: it stops
browser attacks, but any local process that can reach loopback and holds the URL
(including the MCP client's own agent) can complete the page. Real-money approval needs an
out-of-band channel.

## Outside this release

Remote HTTPS/client OAuth, durable credential storage, process supervision,
multi-tenancy and real-order execution are not implemented. Account reporting
covers the stocks held now — cost basis, market value and unrealized profit and
loss, with levels around each holding. What is *inside* an account's other classes
is not read: options, crypto, futures, event contracts, fixed income and mutual
funds are reported at the value Robinhood states for each, itemized in the header,
with the note naming which of them the table leaves out. Realized profit and loss,
transaction history and time-weighted return are not read at all, and no field in
`get_portfolio` carries a day change — so the report claims none rather than
rendering an em-dash that reads as a broken page.

A real Robinhood login, market-hours freshness and the user's chat-client setup
remain attended acceptance gates; mock tests do not establish those facts.
