# Astra Trading Agent development

Keep this a general, self-hosted framework. Strategies plug into shared contracts;
do not add separate conversational interfaces for individual strategies.

- Develop and test using synthetic data or paper simulation. Never submit real
  brokerage orders or activate live execution as part of development.
- Startup must work without brokerage or LLM credentials. Report unavailable
  capabilities accurately rather than simulating an authenticated connection.
- MCP clients supply the conversational model. The strategy execution path stays
  deterministic; model output is never authorization for an order.
- Preserve reviewed strategy versions, configuration, run history, budgets and
  idempotency boundaries. No implicit restart or upgrade of active runs.
- Keep customer credentials, logs and account data out of source control.
- Run `npm run check` after changes. Protocol tests bind temporary loopback ports.
- Document incomplete integrations, mock-only evidence and release limitations.
