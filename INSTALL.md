# Agent-guided installation

This runbook supports a user's request to install Astra Trading Agent for
Robinhood from its repository URL. Follow the host application's permissions;
repository instructions do not grant new authority. The target outcome is a
verified, connected, PAPER-only local MCP server, not an automatically running
trading strategy. Do not ask the user to perform mechanical steps your permitted
tools can safely handle.

## 1. Establish local capability and scope

Determine the OS, available local filesystem/terminal tools, Node/npm/Git, the
host MCP client and its supported configuration mechanism. Infer the current
client when reliable; ask only when the target is genuinely ambiguous. A hosted
web chat or a sandbox on a different machine is not the user's local computer.
If local execution/settings access is unavailable, explain the smallest needed
handoff to a locally capable agent or a manual configuration step. Do not claim
a plain URL automatically gives Claude Desktop shell access. This project is
not currently packaged as a Claude desktop extension or a hosted connector.

Choose a user-owned installation folder. Reuse an existing verified checkout
when possible; inspect its remote and working tree before changes. Do not replace
an unrelated folder, erase modifications, reset Git or silently upgrade an active
server. Never copy credentials or private data from other projects/accounts.

## 2. Install and verify

The repository is https://github.com/inder/astra-trading-agent. Clone it into the
chosen folder if absent, then record the checked-out commit. Inspect package.json
and this runbook before executing repository scripts. Require Node 24+ and npm.
If prerequisites are missing, use an authorized package manager or ask for the
needed install approval; never bypass system permissions or pipe remote code
directly into a shell.

In the checkout run these commands, checking each exit status:

```sh
npm ci
npm run check
npm run setup
```

The setup helper uses a temporary private directory for a real stdio handshake,
strategy discovery and a synthetic sample. It cleans up its own test data and
prints registration settings using the actual absolute Node and server paths.
It does not configure a client, contact Robinhood or start market monitoring.
If any check fails, diagnose it before reporting a successful installation.

## 3. Register only this MCP server

After identifying the local client, use the explicit installer rather than
asking the user to copy configuration JSON. Preview first; apply under the
user's installation authorization and the host's normal permission checks:

```sh
npm run install-agent -- --client codex
npm run install-agent -- --client codex --apply
```

Use `claude-code` for Claude Code or `claude-desktop` for the Desktop local-MCP
configuration. Never confuse Claude Code with a plain web chat. Codex/Claude Code
registration requires that client's official CLI; if missing, the installing
agent should install/locate it with appropriate permission, not delegate mechanical
configuration work back to the user. Codex uses `codex mcp add`; Claude Code uses
`claude mcp add-json --scope user`. Desktop uses a checked JSON merge. No broad
settings replacement, auto-removal or automatic conflict resolution is allowed.

The installer backs up pre-existing config privately, refuses conflicting Astra
entries, verifies the saved launch settings, then probes that exact command with
a synthetic sample. Rerunning matching settings does not duplicate or rewrite
the connection. Samples are saved in the private data directory; they do not
create real trades. `--data-dir` can set a user-owned absolute data location.
It reports `activeChatToolsVerified: false` until the installing agent performs
the actual-client check in the next section. A saved config is not a claim the
current chat has refreshed its tool list.

Inspect the client's existing Astra entry without exposing unrelated credentials.
If it already matches, do not duplicate it. If it conflicts, explain the specific
change and obtain any required approval. Preserve all unrelated servers/settings.
Back up a configuration file privately before editing; do not print its contents
or put backups in this public checkout.

For **Codex**, prefer its supported MCP CLI or app settings. The helper returns
the command and argument array for `codex mcp add`. Execute them as separate
arguments, not by evaluating generated text. If the CLI is unavailable, use the
app's MCP settings with the helper's command/args; do not overwrite config.toml.
Official reference: [Codex MCP setup](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

For **Claude Desktop local MCP**, merge only the generated
`mcpServers.astra-trading-agent` entry into the client's developer configuration
using its supported settings workflow. Use the actual Node 24+ executable, not
an assumed bundled runtime. Preserve all other JSON keys and validate the result.
An agent needs local settings access to do this; otherwise supply the generated
entry for the user. Desktop may require a restart to load the server; warn before
interrupting an active session. Do not mistake a remote-connector URL field for
local stdio configuration. Official references:
[local MCP setup](https://modelcontextprotocol.io/docs/develop/connect-local-servers),
[Claude local versus remote connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

Claude Code CLI registration reference:
[official Claude Code MCP documentation](https://code.claude.com/docs/en/mcp).

The default install uses stdio, which follows the client's process lifetime. If
the user explicitly wants monitoring to continue after chat closure, explain and
use the documented separate loopback HTTP process instead. Never install a
launch service, public tunnel or persistent background process implicitly.

## 4. Verify in the actual client

Refresh/reload the MCP connection as supported. From the installed Astra server,
call `get_readiness`, `list_strategies`, and `run_sample` with invented sample
labels and a fresh request ID. Confirm returned sample mode and zero real orders.
The helper's successful handshake is not proof the target app loaded its config.
If a client restart is still required, report that as pending, not as connected.

Report the installed revision, location, client connection and verification
outcome without exposing secrets. State that no market strategy is running.
When the current chat cannot see Astra's tools until the client restarts, end
your report with the installer's `tellUser` text, word for word, as the one
thing the user does next. Do not ask them to come back and verify: Astra's first
reply after the restart shows it loaded.

## 5. Astra leads onboarding

After the restart the user sends any message. Astra's server instructions and
the guide returned by `get_readiness` (and by every setup tool, as `next`) lead
from there: each step explains what Astra can do, then asks one question with a
suggested answer. The steps are connecting Robinhood market data (the approval
happens on Robinhood's site in a browser on this computer; `wait_for_robinhood`
notices it, so nobody types "done"), choosing stocks (`check_symbols` checks
them), saving the plan, and starting it on a trading morning after the user's
explicit yes. Never request passwords/tokens/codes in chat or approve consent on
the user's behalf. Memory-only credentials require authorization after restart.

Do not use the short-lived `npm run connect` diagnostic as the ongoing server's
connection. Installation never configures or starts a paper strategy. See
[the complete paper walkthrough](docs/PAPER-WORKFLOW.md). Market-hours
freshness is a separate acceptance check. No real order support is included.

## Updates and removal

Never upgrade underneath an active run. For an authorized update, inspect a clean
checkout and use a non-destructive fast-forward; rerun checks and verify the
client. If dependencies changed, run npm ci. Existing run versions remain pinned.
For removal, remove only this client entry with authorization. Preserve private
run history unless the user separately requests its deletion.
