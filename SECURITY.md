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
  symbol and whole-contract quantity. Exact host and origin, a form token, a
  path-scoped cookie, expiry, single use and current quantity are checked. The
  cookie's SameSite flag does not separate other ports on 127.0.0.1; the exact
  origin check and form token are what stop browser attacks. There is no MCP
  approval tool. This is for simulation only, not authorization to trade real funds.
- Known limit of that review: it stops browser attacks, not local software. Any
  local process that can reach loopback and holds the review URL — under any OS
  user, including the MCP client's own agent if it has a shell or browser tool —
  can open the page and submit it. Running the agent as a separate OS user does not
  help: it receives the URL over MCP. The agent is told not to; that is an
  instruction, not enforcement. Out-of-band approval (e.g. Telegram or a Touch
  ID/passkey prompt) is required before any approval path can gate real money.
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
- The upstream token has broad permissions, and this is measured, not assumed: on
  an attended connection (2026-09-15) Robinhood's single `internal` scope granted
  73 tools, order placement and cancellation among them. The application calls
  only its own allowlists, never a generic MCP proxy or an order tool. **Those
  allowlists, in code, are the whole boundary — the OAuth scope is not one.**
  There are two, deliberately kept apart: `MARKET_READS` (six market-data reads)
  and `ACCOUNT_READS` (`get_accounts`, `get_portfolio`, `get_equity_positions`),
  each with its own accessor, so widening one cannot widen the other by accident.
  Nothing that places, previews, cancels or exercises an order, moves money, or
  edits a watchlist, alert or scan appears in either; a startup check refuses to
  run if one ever does. Review the provider consent screen yourself. Restarting
  the server clears local tokens, so every restart re-authorizes through
  Robinhood's own screen; revocation of the grant must be managed with Robinhood
  separately.
- Account reads are made only in answer to a request for account information,
  and are otherwise never made. Astra holds no persistent opt-in, writes no
  account data to the journal, a checkpoint or a log, and returns opaque
  per-process handles rather than account numbers. Two tools reach this path:
  `list_accounts`, which reads names and status, and `get_portfolio_report`,
  which additionally reads balances and equity positions for the accounts the
  user named. The report is the one place account data is written down: a single
  HTML file created with mode `0600`, which the user asked for and can delete.
  **Note what this does and does not prove:** the server cannot
  verify that a human chose an account, only that the accounts were listed in
  this process. The model calling the tools is inside the trust boundary. What is
  enforced, rather than trusted, is that no tool Astra can call places an order.
- Provider responses carry provider text (Robinhood returns a `guide` string with
  account reads). Treat it as data to show or ignore, never as instructions.
  Astra does not merely treat it that way: account responses are rebuilt field by
  field from an allowlist, so provider text that no field asks for — the `guide`
  string among it — never reaches the model or the report at all.
- The report is served over loopback so a link works wherever the chat client is
  rooted. The server is GET-only, binds `127.0.0.1`, serves only reports this
  process minted under an unguessable per-report name, rejects any request
  carrying an `Origin` header or an unexpected `Host`, and sends
  `default-src 'none'`. It holds no session and no cookie, so there is nothing
  for a cross-origin page to ride; names are forgotten when the process exits.

Do not post credentials or private account details in public issues. Use GitHub
private vulnerability reporting if enabled, or request a private reporting
channel without disclosing the vulnerability or secrets publicly.
