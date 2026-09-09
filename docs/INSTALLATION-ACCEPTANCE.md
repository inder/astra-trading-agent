# Least-touch installation acceptance

Target: an owner with a locally capable Codex or Claude Code agent provides only
the public repository URL and asks for installation. The agent reads INSTALL.md,
handles prerequisites, installs dependencies, verifies, registers Astra, refreshes
the host's connection, and checks the tools. The owner handles necessary system
permissions and Robinhood browser consent, not path editing or JSON assembly.

## Automated evidence gates

The `clean-install` CI job uses disposable macOS and Linux runners, separate from
the development machine. It installs official pinned Codex/Claude Code CLIs,
clones the public repository into a new path containing spaces, installs locked
dependencies, and runs the setup checker. It then uses the real client CLIs to
register Astra, checks the actual persisted settings, launches exactly the stored
command, and exercises discovery and a synthetic sample. Reinstallation must
preserve the connection, and unrelated fixture connections must remain unchanged.

The Codex gate additionally starts the real pinned client's app-server, opens an
ephemeral local session without a model turn, verifies Astra is `connected`, and
calls `get_readiness`, `list_strategies`, and `run_sample` through Codex itself.
This verifies client loading and calls, not just an independent SDK handshake.

The local suite separately checks preview-only behavior, private backups,
malformed settings, mismatched existing Astra entries, failed preflight, and
settings changed during verification. The desktop JSON adapter is unit-tested;
this is not an end-to-end GUI test of Claude Desktop.

The CI job's pass/fail result is the evidence, not the presence of this document.
Do not describe a fresh-install matrix as passing until that revision's jobs pass.

## Remaining distinctions

- No authenticated LLM conversation is run in CI. Registration/launch mechanics
  are tested, not a guarantee that every model follows the runbook correctly.
- The active chat must actually load Astra's tools. A reload, restart or new
  conversation may be needed depending on the client. The installer does not
  falsely report this completed from a config-file write.
- A plain Claude Desktop/web chat without local execution cannot self-install
  from a repository URL. Use locally capable Code mode/Claude Code, another local
  installer agent, or the documented Desktop configuration route.
- Hosted Codex cannot configure a different computer's local app automatically.
- Node 24+ is provisioned in CI. Missing local prerequisites must be handled by
  the installing agent with the owner's permission. Windows is not yet covered
  by the clean-machine CI matrix.
- Robinhood approval and market-hours quotes remain an attended acceptance gate.
  No accounts, credentials, real trading or broker orders are used in these tests.

Handoff must distinguish verified local-install mechanics from these external
gates. It must not call a configuration fragment or unit-test pass a completed
fresh-computer conversational installation.

## Independent installation trial — September 9, 2026

A fresh installation agent, without development history or procedural coaching,
was given the public repository URL and asked to install Astra for Codex in a
disposable Linux computer. Node/npm/Git and Codex were already installed, as in
the intended starting environment. No host directories or credentials were
mounted or copied. The agent installed public revision
`837b3a1e4869395f4c493218945531f7f3ad7d24`, following the published runbook:

- Dependency installation, typecheck and all 61 tests passed.
- Setup, preview, client registration and the stored-command sample passed.
- Reinstallation made no configuration changes or duplicate connection.
- No manual JSON assembly, path editing or product-specific advice was needed.
- A separate actual Codex client check loaded all 19 Astra tools and successfully
  called readiness, discovery and the synthetic sample with zero real orders.

There was one infrastructure interruption: the container stopped during setup.
After the environment was restarted, setup and the remaining checks exited
successfully. No Astra defect was established from that interruption.

This was an LLM-directed installation using an isolated target, not a signed-in
Codex model conversation inside that target. A credentialless model attempt
returned HTTP 401 as expected. Client tool invocation was verified separately
through its local protocol. Claude Code registration is covered by the clean
macOS/Linux CI matrix; a Claude model-driven installation and Desktop GUI reload
have not been tested. The user's own client login, tool permissions/reload,
Robinhood consent and market-hours acceptance remain explicit external steps.
