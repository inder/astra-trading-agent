# Initial milestone readiness

Implemented: credential-free MCP startup, versioned strategy discovery,
configuration preview, deterministic synthetic runs, immutable completed sample
logs, retries, stdio and authenticated loopback HTTP transports.

Implemented and mock-tested: customer browser authorization, memory-only tokens,
restricted upstream MCP reads, equity quote normalization and freshness flags.
Production login and quote delivery still need a user-approved acceptance test.

Not implemented: continuous paper runs, real trades, position close/trim tools, real-account P&L, remote HTTPS
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

Local typecheck and all 31 tests pass, including real MCP client/server
handshakes over stdio and authenticated loopback HTTP. Tests cover missing
credentials, schema validation, synthetic sizing/exits, stored-run retries,
corrupt records, invalid paths, plug-in injection, unauthorized HTTP requests,
cross-origin/host rejection and request-size limits. No brokerage was contacted.
OAuth tests exercise SDK discovery, registration and PKCE against mocks, callback
rejection/expiry, concurrent setup, denied consent and unavailable tools. The
provider's public metadata was fetched without credentials; authenticated account
access has not been tested. No end-to-end chat-application connection is claimed.
The CI workflow repeats checks on Node 24 and 26 after each push.
