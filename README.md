# Astra Trading Agent for Robinhood

A self-hosted MCP server with a versioned library of deterministic trading
strategies. Your MCP-compatible chat application provides the conversational
model; this server provides validated tools and durable run records.

Independent project, not affiliated with OpenAI or Robinhood. The MCP server is
model-agnostic; its name does not require a particular model or provider.

**Version 0.3: the end-to-end PAPER workflow is implemented and tested with mocked
market data.** Configure and start continuous strategies, inspect positions and
option P&L, review trims/closes in your browser, and recover saved positions.
Independent browser authorization is mock-tested; successful Robinhood login and
market-hours delivery still need an attended acceptance test. No real orders or
real-account P&L are supported. There is no live flag. Installing it does not
start a strategy. This is not a
production trading system or a claim of strategy profitability.

## Quick start

### Install through your coding agent

One-line request:

> Install Astra Trading Agent for Robinhood from https://github.com/inder/astra-trading-agent using its INSTALL.md instructions.

Give a locally capable coding agent this repository URL and ask it to install
Astra. [INSTALL.md](INSTALL.md) is the agent-facing runbook: prerequisites,
verification, client registration, preservation of existing settings, and
Robinhood onboarding. The agent performs the mechanics; the user handles any
required permissions and browser consent. A chat client without local execution
or settings access cannot gain those capabilities merely from a repository URL.

`npm run setup` verifies the real local MCP handshake and a synthetic sample,
then prints machine-specific registration settings. It never modifies your chat
client settings, contacts Robinhood or starts a market strategy on its own.

For a locally capable agent, `npm run install-agent -- --client codex --apply`
also performs checked registration and verifies the saved launch command. It
supports `codex`, `claude-code`, and a `claude-desktop` configuration adapter.
Without `--apply` it only previews. Existing settings are preserved; conflicting
Astra entries require explicit review. Client permission/reload and Robinhood
browser consent are not bypassed. See the [acceptance criteria](docs/INSTALLATION-ACCEPTANCE.md)
for exactly what has and has not been tested; ordinary Claude web chat does not
become a local installer merely by receiving a URL.

### Manual installation

Requires Node.js 24 or newer and npm. No OpenAI key, Robinhood credentials, or
Codex installation is needed for the server or sample.

```sh
git clone https://github.com/inder/astra-trading-agent.git
cd astra-trading-agent
npm ci
npm run check
npm run demo
```

The demo uses invented prices for DEMOA, DEMOB and DEMOC. It exercises opening
range entry, a two-position cap, four whole-contract trims, and a protective
stop. It writes a complete synthetic event record and prints its location.
Option exit prices are not modeled, so P&L is unavailable, not zero. The sample
date is fixed to September 8, 2026; symbols are labels, not fetched market data.

## Connect a local MCP client

Use your client's local stdio MCP configuration. Substitute absolute paths on
your machine; the command must point to Node.js 24+.

```json
{
  "mcpServers": {
    "astra-trading-agent": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/astra-trading-agent/src/agent-server.ts"],
      "env": { "TRADING_AGENT_DATA_DIR": "/absolute/path/to/your/private/astra-data" }
    }
  }
}
```

Ask naturally: “Which strategies are available?”, “What needs connecting?”,
“Preview an opening-range sample for DEMOA and DEMOB”, “Run that sample”, or
“Explain the decisions in my last run.” The connected model translates these
requests into MCP calls. The server itself is not an embedded LLM or a fixed
question router. Client access, configuration and model permissions vary.

Start stdio directly with `npm start` (waiting silently for MCP input is normal).
For client configurations, invoke Node directly rather than npm so npm banners
cannot contaminate protocol stdout.

### Local HTTP development

Streamable HTTP is also available on loopback only. Set
`TRADING_AGENT_MCP_TOKEN` to a randomly generated secret of at least 32 characters
in your environment, then:

```sh
npm start -- --transport http --port 8787
```

The endpoint is `http://127.0.0.1:8787/mcp` and requires an HTTP Authorization
Bearer header. There is no browser CORS access, public listener, hosted endpoint
or inbound client OAuth onboarding. Do not publish or tunnel this endpoint as
a production service. Connecting cloud chat applications requires a separately
designed authenticated HTTPS deployment; localhost support is not cloud-client
compatibility. The token grants access to all sample records in that server's
data directory, paper controls and broker read connection: this release is
single-owner, not multi-tenant. Keep the HTTP process running independently of
the chat client if strategies need to continue after the chat disconnects.

## Tools

| Tool | Purpose |
| --- | --- |
| `get_readiness` | Capabilities, absent connections, onboarding guidance |
| `list_strategies` | Supported plug-ins and versions |
| `preview_strategy` | Validate sample settings without writing or starting |
| `run_sample` | Run synthetic data and save events; idempotent request ID |
| `list_runs` | Read saved sample history |
| `get_run` | Read configuration, decisions and outcome |
| `connect_robinhood` | Start browser authorization; never accepts credentials in chat |
| `get_broker_status` | Check authorization and available read capabilities |
| `get_market_quotes` | Read normalized equity prices and freshness flags after authorization |
| `configure_paper_strategy` | Save session settings without starting |
| `start_paper_run` | Start continuous simulation after authorization |
| `resume_paper_run` | Recover existing positions only, no new entries |
| `stop_paper_run` | Stop monitoring; does **not** close paper positions |
| `list_paper_runs` | List history and attachment/recovery state |
| `get_paper_run` | Positions, budget and estimated option P&L |
| `get_paper_events` | Page through the immutable decision journal |
| `get_daily_pnl` | Daily simulated P&L, never account-wide P&L |
| `propose_position_change` | Create a local browser review for a trim/close |
| `get_position_review` | Read approval status; cannot approve a sale |

`trading-agent://readiness` is also available as an MCP resource.

No tools execute shell commands, accept arbitrary filesystem paths, read account
positions or submit brokerage orders. The upstream client enforces a runtime
allowlist of market-data reads even if Robinhood advertises order tools.

## Connect Robinhood independently

Ask your connected MCP client to connect Robinhood. Open the returned Robinhood
authorization link in a **desktop browser on the machine running Astra**. Review
the permissions on Robinhood's page. The provider returns to a temporary
loopback callback; passwords, authorization codes and access tokens never need
to be pasted into chat. Ask for broker status, then request quotes.

This uses Robinhood's published MCP endpoint, OAuth discovery, dynamic client
registration and PKCE. Every callback validates an unpredictable state value;
attempts expire after ten minutes. Credentials are **memory-only** in this
milestone and disappear when the server exits. Authorize again after restart.
No credentials are copied from Codex or any other application. Robinhood's
consent may grant broader capabilities than this adapter uses; the local
read-only restriction is not a claim that Robinhood issued a read-only token.

`npm run connect` is an attended diagnostic using the same flow. It verifies
the MCP handshake and required quote tool, then disconnects. To keep reading
quotes, authorize through the running MCP server instead. No browser window is
opened automatically. Remote/headless callback routing is not supported yet.

Implementation references: [Robinhood onboarding](https://robinhood.com/us/en/support/articles/agentic-trading-overview/),
[resource metadata](https://agent.robinhood.com/.well-known/oauth-protected-resource/mcp/trading),
[authorization metadata](https://agent.robinhood.com/.well-known/oauth-authorization-server/mcp/trading).
Public metadata was checked on September 9, 2026. No authenticated production
session is claimed by the mocked OAuth tests.

## Complete paper workflow

Use the running MCP server, not the short-lived `connect` diagnostic. Follow the
[end-to-end walkthrough](docs/PAPER-WORKFLOW.md) for exact inputs and expected
results. Discover strategies, authorize Robinhood, configure a supported session
and ticker list, review settings, then explicitly start before 9:32 a.m. New York
time. Ask for positions, daily paper P&L or event history. Ask for a 25% trim or
full close and review the exact whole-contract quantity in your local browser.
Stopping monitoring retains positions; request closes first if that is intended.

The first strategy supports strict opening-range and separate drive-then-balance
setups, with optional final-two-minute premarket range inclusion. It allows two
to four calls per entry, at most two tickers/session, $2,000 including a $1 per
contract fee reserve per ticker, $4,000 total. Proceeds never replenish the budget.
The expiry is the first week-ending expiration with at least three trading
sessions counting the trade day. In a normal week that means Monday–Wednesday
trades use that week's Friday and Thursday/Friday trades use the following Friday.
Holidays count as non-sessions: when Friday is a holiday the week ends on
Thursday, and a Wednesday before a holiday Thursday or Friday rolls to the next
week. If that expiration is not listed, the stock is skipped for the day rather
than traded in a later expiry.
Selection prefers four contracts, then three, then two; within that quantity,
nearer strikes and tighter spreads win.

The stock's range low minus 0.1% is the protective threshold. A breach below it
requests all remaining calls be sold. An unfilled protective exit stays pending
through rebounds and recovery. The profit ladder sells whole contracts at stock
gains of 5%, 10%, 15%, and 20% from entry, not option-price gains. User trims count
toward contracts already sold; they do not add extra later-rung sales.

Simulation assumes fresh ask entry and fresh bid sales, **not executions**. It
does not model queue position, partial fills, market impact or actual fees. P&L
excludes fees; stale marks become unavailable. Polled quotes cannot prove no
unseen intrasecond crossing occurred. Data errors halt the run for inspection.

## Persistence and stopping

Default data directory: `~/.trading-agent`, overridable with
`TRADING_AGENT_DATA_DIR` or `--data-dir`. Keep it private and outside the checkout.
Each completed sample stores configuration, strategy version, numbered events
and summary together in `runs/<requestId>.json`. Records are published atomically
without overwrite. Retrying the same ID and inputs returns the existing result;
changing inputs with that ID fails. Different clients must name their run
explicitly; there is no shared “selected position” state.

Paper runs store immutable revisions in `paper/<runId>/`, with events, pinned
settings/version and checkpoint published together. One process owns a run and
one run reserves each strategy/date. Do not edit journals or reservations to
reset budgets. Logs grow during sessions; no automatic deletion policy exists.

The HTTP timer continues after chat disconnection while its process/computer
stay running. **Stdio follows its client's process lifetime.** No launch daemon
or automatic restart is installed. Ctrl-C stops monitoring and checkpoints;
a crash preserves the last committed revision. Reauthorize after restart and
explicitly resume existing positions. Recovery allows no new entries after a
gap and no expired sessions. The runner attempts to flatten simulated positions
one minute before close; missing valid quotes leave unresolved positions visible,
without pretending to sell, exercise or manage them overnight. There is no
automatic date rollover. The exchange calendar covers **2026–2027** (NYSE
holidays and early closes); anything outside it is refused, not guessed.

A crash during ownership acquisition can leave an `acquiring` guard. It blocks
automatic recovery for offline inspection. Never repair ownership while another
server might still be running.

## Extension and release roadmap

See [architecture](docs/ARCHITECTURE.md), [security](SECURITY.md) and
[readiness](docs/READINESS.md). Strategy source and historical run records remain
separate. Publishing an update does not activate a strategy or migrate a run.

License selection is pending owner confirmation. Public source alone is not an
open-source license; package publication is disabled until release review.
