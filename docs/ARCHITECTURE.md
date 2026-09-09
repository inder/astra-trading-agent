# Architecture

Client LLM → MCP adapter → shared service → registered strategy adapter.

`agent-mcp.ts` defines validated tool schemas and bounded capabilities.
`agent-service.ts` handles discovery, preview, idempotency and persistence.
`agent-strategies.ts` registers strategy versions via `AgentStrategy`.
`orb-options.ts` contains the extracted deterministic engine. `orb-config.ts`
holds its supported risk settings. Neither requires a broker or language model.

## Adding a strategy

Implement `AgentStrategy` with stable ID/version, capability metadata, validated
configuration preview, and a deterministic synthetic-sample adapter returning
common events and summary. Register it in `agentStrategies`. Do not add
strategy-specific tools or chat parsing. Tests should cover invalid inputs,
deterministic outcomes, duplicate requests and transport-independent discovery.
The shared service accepts an injected registry so extension is testable without
changing the MCP server. The initial sample interface is deliberately not yet a
general live-runner interface.

## Next milestones

1. Add a broker-neutral market-data provider and secure, customer-owned
   authorization flow. Advertise only verified capabilities; disconnected startup
   must continue to work. Do not import private Codex session credentials.
2. Add an independently supervised paper runtime, normalized position/P&L read
   models, structured event logs, crash reconciliation and explicit lifecycle
   controls. A chat connection must not own its lifetime.
3. Add reviewed controls with expiring, exact, state-bound approval; never trust
   a model-generated `confirmed: true` as user approval.
4. Design authenticated remote HTTPS access and client onboarding. The current
   development HTTP transport is not a substitute for OAuth or tenant isolation.
5. Validate a second real strategy and a clean-machine installation before
   claiming the complete extensible product is ready.

No arbitrary strategy uploads or runtime code generation are exposed over MCP.
New packages are reviewed, tested and versioned by developers.
