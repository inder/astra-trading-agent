# Initial milestone readiness

Implemented: credential-free MCP startup, versioned strategy discovery,
configuration preview, deterministic synthetic runs, immutable completed sample
logs, retries, stdio and authenticated loopback HTTP transports.

Not implemented: customer Robinhood authorization, actual market data, continuous
paper runs, real trades, position close/trim tools, real-account P&L, remote HTTPS
onboarding, multi-tenant operation, or deployment into a chat application.

The bundled opening-range engine supports both strict and balance setup logic.
The built-in demo specifically exercises the strict entry, two-position cap,
sizing, trims and stop, not complete market-history or fill simulation.
The inherited exchange calendar only supports 2026. The sample uses a fixed
supported date and must not be described as a current-session trading run.

This repository is an extracted first milestone, not a published production
release. No private configs, brokerage records, session transcripts, logs or
source repository history belong in it.

## Verified for this milestone

Local typecheck and all 24 tests pass, including real MCP client/server
handshakes over stdio and authenticated loopback HTTP. Tests cover missing
credentials, schema validation, synthetic sizing/exits, stored-run retries,
corrupt records, invalid paths, plug-in injection, unauthorized HTTP requests,
cross-origin/host rejection and request-size limits. No brokerage was contacted.
The CI workflow repeats checks on Node 24 and 26; remote results must be checked
after the first push. No end-to-end chat-application connection is claimed.
