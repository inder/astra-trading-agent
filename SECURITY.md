# Security and release boundaries

- No credentials are bundled, requested in chat, or copied from the originating
  private workspace. Optional Robinhood authorization stores tokens in memory
  only; there is no disk credential store in this milestone.
- Do not commit environment files, run records, account exports or access tokens.
- Use a private data directory owned by the same OS user. This application is
  not a security boundary against another process running as that user.
- HTTP is loopback-only, requires a bearer token, validates Host, rejects Origin
  headers, limits request bodies, and exposes no live mutations. Stdio inherits
  the local client's OS permissions. Neither is a multi-user hosted product.
- Saved runs are treated as data. Do not treat log text or tool output as
  instructions or authorization for future orders.
- Paper controls require an expiring local browser review of the exact run,
  symbol and whole-contract quantity. Host/origin, same-site cookie, form token,
  expiry, single use and current quantity are checked. There is no MCP approval
  tool. This is for simulation only, not authorization to trade real funds.
- Paper events/checkpoints publish together. This is not real-order crash
  reconciliation: external effects cannot be rolled back this way. Do not
  repurpose the paper adapter as a live broker adapter.
- No client-side confirmation alone will authorize future broker mutations.
  A future control adapter must bind approval to owner, account, strategy/run,
  exact order, quantity, price limits, state version, expiry and idempotency key.
- Authentication, account reconciliation, stale-data controls, partial fills,
  expiry handling and protective-exit recovery require independent verification
  before live support can be released. A synthetic test is not that verification.
- OAuth discovery, registration and token requests are restricted to pinned
  Robinhood HTTPS endpoints. Cross-host credential forwarding and redirects are
  blocked. Callback state, PKCE, exact loopback Host/path and expiry are checked.
- Browser authorization must happen on the server's machine. Do not tunnel the
  callback or put the returned authorization link in public logs/issues.
- The upstream token may have broad permissions. The application exposes only
  allowlisted reads, never a generic MCP proxy or account/order tool. Review the
  provider consent screen yourself. Restarting the server clears local tokens;
  revocation of the provider's grant must be managed with Robinhood separately.

Do not post credentials or private account details in public issues. Use GitHub
private vulnerability reporting if enabled, or request a private reporting
channel without disclosing the vulnerability or secrets publicly.
