# Security and release boundaries

- No credentials are bundled, requested in chat, or copied from the originating
  private workspace. There is no Robinhood integration in this distribution.
- Do not commit environment files, run records, account exports or access tokens.
- Use a private data directory owned by the same OS user. This application is
  not a security boundary against another process running as that user.
- HTTP is loopback-only, requires a bearer token, validates Host, rejects Origin
  headers, limits request bodies, and exposes no live mutations. Stdio inherits
  the local client's OS permissions. Neither is a multi-user hosted product.
- Saved runs are treated as data. Do not treat log text or tool output as
  instructions or authorization for future orders.
- No client-side confirmation alone will authorize future broker mutations.
  A future control adapter must bind approval to owner, account, strategy/run,
  exact order, quantity, price limits, state version, expiry and idempotency key.
- Authentication, account reconciliation, stale-data controls, partial fills,
  expiry handling and protective-exit recovery require independent verification
  before live support can be released. A synthetic test is not that verification.

Do not post credentials or private account details in public issues. Use GitHub
private vulnerability reporting if enabled, or request a private reporting
channel without disclosing the vulnerability or secrets publicly.
