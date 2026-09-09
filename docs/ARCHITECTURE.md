# Architecture

Astra Trading Agent for Robinhood is one shared framework, not a separate chat
implementation for each bot. The local MCP-compatible client supplies the LLM.

```text
Chat client → MCP adapter → TradingAgentService
                            ├─ registry → sample adapters
                            ├─ PaperController → strategy PaperRuntime
                            │                     └─ PaperMarket → Robinhood reads
                            ├─ PaperReviews → local browser → serialized control
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
payload. The calendar is NY equity sessions in 2026; other markets need explicit
support and tests. No uploads, generated code or shell commands are exposed.

Each strategy must test inputs, entry/exit invariants, budgets, recovery, stale
data, idempotency and a synthetic full-workflow example. Publishing never changes
the pinned version/configuration of an existing run.

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
actual account holdings. This is not a real-trade authorization system.

## Outside this release

Remote HTTPS/client OAuth, durable credential storage, process supervision,
multi-tenancy, account-wide reporting and real-order execution are not implemented.
A real Robinhood login, market-hours freshness and the user's chat-client setup
remain attended acceptance gates; mock tests do not establish those facts.
