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

The service owns everything the engine refuses to: fetching bars split-adjusted,
rejecting a history that is incomplete, interpolated, duplicated or out of order,
and caching one read per stock per settled session. Bars are kept only through the
last session that has **closed** — the provider returns the session still trading,
and a provisional high, low and close must never be measured or cached as a
completed bar. A stock whose history cannot be read is named in the answer; the
others still answer.

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
multi-tenancy, account-wide reporting and real-order execution are not implemented.
A real Robinhood login, market-hours freshness and the user's chat-client setup
remain attended acceptance gates; mock tests do not establish those facts.
