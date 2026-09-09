# Astra Trading Agent

A self-hosted MCP server with a versioned library of deterministic trading
strategies. Your MCP-compatible chat application provides the conversational
model; this server provides validated tools and durable run records.

Independent project, not affiliated with OpenAI or Robinhood. The MCP server is
model-agnostic; its name does not require a particular model or provider.

**Initial developer milestone: synthetic samples only.** No brokerage access,
live data, real orders, or real-account P&L is implemented in this distribution.
There is no live flag. Installing it does not start trading. This is not a
production trading system or a claim of strategy profitability.

## Quick start

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
or OAuth onboarding yet. Do not publish or tunnel this development endpoint as
a production service. Connecting cloud chat applications requires a separately
designed authenticated HTTPS deployment; localhost support is not cloud-client
compatibility. The token grants access to all sample records in that server's
data directory: this release is single-owner, not multi-tenant.

## Tools

| Tool | Purpose |
| --- | --- |
| `get_readiness` | Capabilities, absent connections, onboarding guidance |
| `list_strategies` | Supported plug-ins and versions |
| `preview_strategy` | Validate sample settings without writing or starting |
| `run_sample` | Run synthetic data and save events; idempotent request ID |
| `list_runs` | Read saved sample history |
| `get_run` | Read configuration, decisions and outcome |

`trading-agent://readiness` is also available as an MCP resource.

No tools execute shell commands, accept arbitrary filesystem paths, request
credentials, fetch market data or submit brokerage orders.

## Persistence and stopping

Default data directory: `~/.trading-agent`, overridable with
`TRADING_AGENT_DATA_DIR` or `--data-dir`. Keep it private and outside the checkout.
Each completed sample stores configuration, strategy version, numbered events
and summary together in `runs/<requestId>.json`. Records are published atomically
without overwrite. Retrying the same ID and inputs returns the existing result;
changing inputs with that ID fails. Different clients must name their run
explicitly; there is no shared “selected position” state.

Samples complete synchronously. Closing the server does not erase their records.
There is no background market monitor in this release. Stop a manually launched
server with Ctrl-C; a stdio client owns the process it launches.

## Extension and release roadmap

See [architecture](docs/ARCHITECTURE.md), [security](SECURITY.md) and
[readiness](docs/READINESS.md). Strategy source and historical run records remain
separate. Publishing an update does not activate a strategy or migrate a run.

License selection is pending owner confirmation. Public source alone is not an
open-source license; package publication is disabled until release review.
