# <img src="docs/assets/astra-mark.svg" width="40" height="40" alt="Astra terminal-green tantō icon"> Astra Trading Agent for Robinhood

Astra (अस्त्र) means “weapon” in Hindi. This one comes with risk controls.

*Fighting the markets on your side. Cape not included.*

A self-hosted MCP server with a versioned library of deterministic trading
strategies. Your MCP-compatible chat application provides the conversational
model; this server provides validated tools and durable run records.

Independent project, not affiliated with OpenAI or Robinhood. The MCP server is
model-agnostic; its name does not require a particular model or provider.

**Version 0.4 adds reading your real accounts: a printable portfolio report** —
cost basis, profit and loss, and the support and resistance around each holding on
an expandable chart. Reading is all it does: the same code allowlist that blocks
order tools governs every account call, and no tool Astra can reach places one.

**The end-to-end PAPER workflow, from 0.3, is implemented and tested with mocked
market data.** Configure and start continuous strategies, inspect positions and
option P&L, review trims/closes in your browser, and recover saved positions.
Independent browser authorization is mock-tested; successful Robinhood login and
market-hours delivery still need an attended acceptance test. No real orders are
supported, and no P&L from trading: the report's profit and loss is what holdings
are worth against what was paid for them, never a record of trades, and simulated
P&L is always labelled as such. There is no live flag. Installing it does not
start a strategy. This is not a
production trading system or a claim of strategy profitability.

## Quick start

Astra works inside the AI app you already use, such as Codex or Claude Code. You
talk to it in plain English. It shows you what you already own, with the support
and resistance around each holding, and it watches the stocks you pick at the
market open and simulates option trades on real Robinhood prices. **Paper only:
it never places real orders, and no money moves.**

### 1. Install it with one prompt

Paste this into Codex or Claude Code:

> Install Astra Trading Agent for Robinhood from https://github.com/inder/astra-trading-agent using its INSTALL.md instructions.

Your app downloads Astra, checks it and adds it to itself. You may be asked to
allow a command. It ends with one thing for you to do:

> **Your app** (Codex shown)**:** Quit and reopen Codex, then send any message (for example, "hi"). Astra will guide you from there: connecting Robinhood market data, choosing stocks, and starting a paper run.

The app needs to be able to run commands on your computer. Chat apps that can't
(such as Claude on the web) can't install it; see [Advanced](#advanced).

### 2. Talk to Astra

Below is a replayed session. The replies come from Astra's real tools, run on a
simulated trading day (Tuesday, September 15, 2026) with **invented prices** for
CRWV, HPE and SMCI. No real account was read to write this page. Everything in
"See what you own" is deliberately unmistakable as a mock: account numbers ending
0000 and 1234, a round $100,000 balance, a round $1,000 day, and gains at exactly
10, 20 and 30 percent. No portfolio looks like that. Your session uses live
Robinhood prices and your own accounts, and the wording depends on your AI app.
Two answers come from Astra's rules and settings rather than a tool, and are
marked.

#### Get started

**You:** hi, what can you do?

> **Astra:** I'm installed and working. Setup has three steps: connect Robinhood market data, pick the stocks to watch, then start a paper run on a trading morning.
>
> I watch the stocks you pick at the market open and simulate option trades on real Robinhood prices. I never place real orders, and no money moves. To see those prices I need read-only access to Robinhood market data, which you approve on Robinhood's own website; I never see your password.
>
> Shall I create the Robinhood link now, or would you like a practice run on made-up prices first?

**You:** Show me a practice run first.

> **Astra:** Here's a practice run on made-up prices, with three pretend stocks (DEMOA, DEMOB, DEMOC) on a fixed sample day. Nothing real was traded.
>
> - All three set an opening range of $100 to $101 in the first two minutes.
> - DEMOA and DEMOB then traded at $101.10, above the high, so I bought 4 call contracts on each.
> - DEMOC broke out too but was skipped: the plan allows 2 stocks a day.
> - DEMOA's option kept climbing: 2 contracts sold at 2× the entry price, 1 at 3× and the last at 5×.
> - DEMOB fell back below its $100 opening low, so its stop sold everything.
>
> There's no P&L for this practice run: the made-up data has no option price at DEMOB's stop, so I leave it blank rather than guess.

**You:** Which strategies do you have?

> **Astra:** One: **Opening-range call options** (version 0.9.0). The first two minutes after the open set each stock's high and low. A trade above the high buys call options; a trade below the low first ends that stock's day.

#### Connect Robinhood

**You:** Connect my Robinhood.

> **Astra:** Open this link in a browser on this computer, sign in to Robinhood if asked, review the requested access and approve it: *(Robinhood approval link)*. I only use market-data reads; my code blocks order tools. I'm checking automatically, so there's no need to type "done".

*(You approve on Robinhood's page.)*

> **Astra:** Robinhood is connected. Next, let's plan a paper run for Tuesday, September 15. Which stocks should I watch? Pick 3 to 5 that trade heavily and have weekly options. I enter at most 2 stocks a day, so extras give me choices.

**You:** Is Robinhood still connected?

> **Astra:** Yes. Quotes and price history are available, and order submission is off. The approval lasts until this app restarts.

#### See what you own

**You:** Which accounts can you see?

> **Astra:** Two: ••••0000 individual and ••••1234 roth ira. I've read their names and status only — no balances, no positions. Which should I report on?

**You:** Both.

> **Astra:** Here's the report: http://127.0.0.1:50000/r/EXAMPLEONLY1 — it opens in your browser and prints.
>
> The two accounts hold $100,000 together: $60,000 in stocks, $30,000 in options and $10,000 cash. The options aren't listed yet — they're counted in the total. Four holdings sit within one daily range of a level: HPE and INTC near support, NVDA and AAPL near resistance. Best by percent are NVDA (+30.0%), HPE (+20.0%) and DELL (+10.0%); worst is INTC (−10.0%). Everything else — cost basis, market value, unrealized P&L, and the zones around each holding — is in the report.

The page shows a row per holding with shares, average cost, last close, market
value, unrealized P&L, and the nearest support below and resistance above.
Holdings closest to a level come first. **Technicals** under any row expands to a
full chart with QTD, YTD, 2-year daily and 5-year weekly tabs, the zones drawn as
bands, and a dashed line at your cost. **Print or save as PDF** from the page;
only the charts you opened print, in the timeframe you chose.

Reading your accounts happens only when you ask about them. The report is the one
place Astra writes any of it down — a single file under its data directory,
readable only by you — and the link dies when Astra restarts. Nothing on the page
is a recommendation: it reports what the rules found.

#### Plan the day

**You:** Watch CRWV, HPE, SMCI and CRVW.

> **Astra:** CRWV ($90.85), HPE ($60.55) and SMCI ($39.95) all work: each has the Friday, September 18 options my entry rule needs. CRVW got no price from Robinhood, so check the spelling. Did you mean CRWV?

**You:** What are they trading at right now?

> **Astra:** Premarket, as of 8:29 AM ET: CRWV $90.85, HPE $60.55, SMCI $39.95. These are before the 9:30 open, not regular-session prices.

**You:** Where is support and resistance for HPE?

> **Astra:** HPE, from two years of daily bars through Monday, September 14. Last close $60.20; a day's swing, overnight gaps included, averages $0.72 (1.2%), and that sets how wide these zones are.
>
> - **Just above:** $60.24–$60.59, touched 17 times, most recently Monday.
> - **Just below:** $59.80–$60.12, also 17 touches, the last one Monday. Then $59.38–$59.63 (16) and $58.93–$59.13 (14).
> - **Rising support line:** up since January 8, with no close dropping through it since; it reaches about $56.88 tomorrow, well under the price.
> - **Falling line since August 26:** touched four times, three of them this month. It sat at $60.35 on Monday and reaches about $60.24 tomorrow — the same shelf as the zone above.
> - **Open gaps below:** June 23 at $56.39–$57.74, and January 6 at $48.96–$50.00. Neither has been filled.
> - **Moving averages:** 10-day $59.84, 21-day $60.36, 50-day $60.04, 200-day $54.40.
>
> This is what the rules found on the chart, not a suggestion to buy or sell. Ask for the quarter or the year instead of two years, and I'll recompute. For the long view, ask for five years and I'll measure weekly bars instead.

**You:** Give me the long view on HPE.

> **Astra:** Five years of HPE, on weekly bars — a different picture from the daily one, so these are weekly levels and shouldn't be read as daily ones. A week moves $1.12 on average (1.9%), which makes these zones wider.
>
> - **Above:** $60.56, touched 3 times, most recently the week of September 7. Then $61.73, once, the week of August 24.
> - **Below:** $59.13–$59.41, touched 7 times, the last the week of September 7. Then a shelf far beneath the price: $48.30–$48.46 (6) and $47.34–$47.87, which held 25 separate weeks into late November 2025.
> - **Rising weekly support line** since July 2025, still unbroken, with 5 touches. It passes near $49.11 next week — a long way under the price.
> - **No unfilled weekly gaps.**
>
> One caveat: I only have price history back to September 2024, so this is 104 weeks, not five years. I'd rather tell you that than show you a short window labelled five years.

**You:** Use CRWV, HPE and SMCI, with $1,000 per trade and $2,000 for the day.

> **Astra:** Here's the plan for Tuesday, September 15, on paper only:
>
> - Watches CRWV, HPE, SMCI; new entries until 11:00 AM ET.
> - Up to 2 stocks, $1,000 per trade and $2,000 per day in paper premium.
> - Buys the call closest to the stock price where at least 4 contracts fit, expiring Friday, September 18.
> - Exits at 2×, 3× and 5×; a safety stop at 50% of the entry price; everything left sells at 3:59 PM ET.
>
> Premium is treated as money you can lose in full. Save this plan?

**You:** Yes.

> **Astra:** Saved as run orb-2026-09-15. Start it now? Starting early is fine: I wait for the open.

**You:** Yes, start it.

> **Astra:** Run orb-2026-09-15 is running, watching CRWV, HPE and SMCI. It waits for the 9:30 AM ET open; each stock's opening range is set by 9:32 AM ET. Keep this app open until 4:00 PM ET. If it closes, monitoring stops, but open positions are kept and can be resumed.

#### During the day

**You** *(9:36 AM)***:** What did you buy?

> **Astra:** One position: 4 CRWV $92 calls expiring Friday, September 18, bought at $2.15 when CRWV was $91.95. That commits $864 of the $2,000 day budget. The bid is $2.07 now, so it's down $32 on paper. If CRWV trades below $90.11, the stop sells everything; the safety stop sells if the option falls to $1.08.

**You:** Why not HPE? And did you try CRWV more than once?

> **Astra:** The opening ranges were set at 9:32: CRWV $90.20 to $91.80, HPE $60.10 to $61.00, SMCI $39.60 to $40.30.
>
> - **HPE** traded at $60.05 at 9:33:08, below its $60.10 low, so it's out for the day.
> - **CRWV** broke out at 9:33:10 at $91.95. My own check a moment later showed $91.70, back under the high, so I waited instead of buying. Two seconds later it was at $91.95 again, and I bought.
> - **SMCI** is still inside its range and can enter until 11:00.

**You** *(10:15 AM)***:** How am I doing today?

> **Astra:** Up $868 on paper. CRWV's option doubled: 2 of the 4 contracts sold at $4.32 for +$434, which covers the premium you paid. The other 2 are worth $4.32 each, another +$434 on paper. The stop has moved to breakeven, so CRWV back at $91.95 sells the rest. Fees aren't included.

**You:** Trim 25% of my CRWV position.

> **Astra:** 25% of 2 contracts rounds to 1 contract. Approve the sale on this page in your browser; it expires in 2 minutes: *(review link)*. Only you can approve it; I can't.

*(You click "Approve simulated sale".)*

**You:** Did it go through?

> **Astra:** Yes. 1 CRWV contract sold at $4.32, +$217. You have 1 left.

#### Stop, restart and pick up again

**You** *(10:30 AM)***:** Stop watching for now.

> **Astra:** Stopped. Your 1 CRWV contract is kept, but its automatic exits are off. Anything still held at the close counts as a total loss. Want me to resume managing it?

*(You restart your computer and reopen the app.)*

**You:** I restarted my computer. Where were we?

> **Astra:** Run orb-2026-09-15 is stopped with 1 open CRWV contract. To manage it I need Robinhood prices again, and approvals last only until a restart. Please approve here: *(Robinhood approval link)*.

*(You approve on Robinhood's page.)*

> **Astra:** Connected. Resume managing the position now?

**You:** Yes.

> **Astra:** Resumed. I'm managing your CRWV contract again: targets, stops and the 3:59 PM ET close-out. No more entries today: after a gap I never open new trades.

**You:** Close everything.

> **Astra:** That's your 1 CRWV contract. Approve the sale here: *(review link)*.

*(You approve it in the browser.)*

> **Astra:** Closed. 1 contract sold at $4.32, +$217. Nothing is held now.

**You:** How did today go?

> **Astra:** +$868 on paper, all realized, from $864 of premium. CRWV's 4 contracts all sold at $4.32: 2 at the 2× target, 1 in your trim and 1 when you closed. HPE dropped out at the open, and SMCI hadn't broken out when you stopped. After the resume I don't open new trades. Fees aren't included.

#### Plans, history and settings

**You:** Set up tomorrow with CRWV and SMCI: at most one stock, $500, entries until 10:30, and two tries per breakout.

> **Astra:** Saved run orb-2026-09-16 for Wednesday, September 16: CRWV and SMCI, 1 stock at most, $500 per trade and per day, new entries until 10:30 AM ET, up to 2 tries per breakout. It won't start until you say yes tomorrow morning.

**You:** Show my paper runs.

> **Astra:** orb-2026-09-15 is today's: running, with nothing held. orb-2026-09-16 is tomorrow's: saved, not started.

**You:** And my practice runs?

> **Astra:** One: practice-1, on made-up prices, completed.

**You:** What can I change?

*(From Astra's settings list; no tool is involved.)*

> **Astra:** Every number in the plan:
>
> - **Money:** premium per trade and per day, and how many stocks a day.
> - **Contracts:** the fewest per trade, and an optional most per trade.
> - **Option filter:** the widest bid-ask spread accepted.
> - **Entries:** how long they stay open after the 9:30 start, and how many tries a stock gets when a breakout slips back under the high before I buy.
> - **Exits:** the three profit targets (2×, 3×, 5×), the safety stop (50%), how far below the opening low the stop sits (0.1%), and when everything sells before the close (3:59).
> - **Timing:** how often I check prices and how old a price may be.
>
> A few more technical ones are listed in the Advanced section. Changes apply to a new plan; a running plan keeps its settings.

#### What Astra won't do

*(These follow Astra's rules; no tool is involved.)*

**You:** Buy 100 shares of NVDA in my IRA.

> **Astra:** I can't place an order, in any account. My code allows nine Robinhood calls: six for market data, and three for reading your accounts, balances and positions when you ask about them. Nothing that places, changes or cancels an order is reachable, whatever Robinhood's consent screen grants. I can add NVDA to a paper plan instead, which simulates the trade and moves no money.

**You:** HPE is sitting on support. Should I buy it here?

> **Astra:** That's your call, not mine: I'm not an adviser, and levels describe what the chart did, not what happens next. I can tell you what those zones are made of — how many times $59.80–$60.12 held, when it was last touched — and put HPE in a paper plan so you can watch the idea without money.

**You:** Here's my Robinhood password: …

> **Astra:** Please don't share it. I never need your password: you approve access on Robinhood's own page, and I never see your credentials.

### Everything you can ask

| Ask something like | What Astra does | Tool |
| --- | --- | --- |
| "hi" / "What can you do?" / "What's next?" | Explains where you are and the one next step | `get_readiness` |
| "Which strategies do you have?" | Lists strategies and versions | `list_strategies` |
| "What would a practice run use?" | Shows a practice plan without running it | `preview_strategy` |
| "Show me a practice run" | Runs made-up prices through the strategy | `run_sample` |
| "Show my practice runs" / "What happened in that practice run?" | Lists them, or explains one | `list_runs`, `get_run` |
| "Connect my Robinhood" | Gives you a Robinhood link and waits for your approval | `connect_robinhood`, `wait_for_robinhood` |
| "Is Robinhood connected?" | Reports the connection and what it can read | `get_broker_status` |
| "Can you watch CRWV, HPE, SMCI?" | Checks each ticker has a price and the options it needs | `check_symbols` |
| "What is CRWV trading at?" | Latest prices, with their time | `get_market_quotes` |
| "Where is HPE's support and resistance?" / "Any open gaps in SMCI?" / "Show me NVDA's five-year weekly levels" | Price zones with how often they held, open gaps, trend lines and moving averages, daily or weekly | `get_levels` |
| "Which accounts can you see?" | Lists your Robinhood accounts, masked, so you can pick | `list_accounts` |
| "Show me my portfolio" / "Print a report for my Roth" | Writes a printable report — cost basis, P&L, and each holding's nearest support and resistance on an expandable chart — and gives you a link to it | `get_portfolio_report` |
| "Plan tomorrow with…" / "Use $500 per trade" | Saves a plan with your settings; doesn't start it | `configure_paper_strategy` |
| "Start it" | Starts the saved plan, after you say yes | `start_paper_run` |
| "What did you buy?" / "How much is committed?" | Positions, budget and paper P&L | `get_paper_run` |
| "Why didn't it buy HPE?" / "What happened this morning?" | Explains each decision from the journal | `get_paper_events` |
| "How am I doing today?" | The day's paper P&L | `get_daily_pnl` |
| "Trim 25% of CRWV" / "Close everything" | Proposes the sale; you approve it in your browser | `propose_position_change` |
| "Did my trim go through?" | Reports whether you approved and what sold | `get_position_review` |
| "Stop watching" | Stops monitoring and keeps positions (their exits pause) | `stop_paper_run` |
| "Show my paper runs" / "Where were we?" | Lists runs and any that need resuming | `list_paper_runs` |
| "Resume" | Manages existing positions again; no new entries | `resume_paper_run` |

## Advanced

### Install through your coding agent

[INSTALL.md](INSTALL.md) is the agent-facing runbook: prerequisites,
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

The Quick start replies were produced by `node scripts/quickstart-session.ts`,
which drives every tool through a simulated day with a fake Robinhood login and
invented prices. It needs no internet connection or credentials.

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
range entry, a two-position cap, the 2×/3×/5× option-price targets, and a
protective stop. It writes a complete synthetic event record and prints its location.
It invents option bids for the targets but not for the stop, so P&L is unavailable,
not zero. The sample
date is fixed to September 8, 2026; symbols are labels, not fetched market data.

### Connect a local MCP client

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

Ask naturally, as in the [Quick start](#2-talk-to-astra). The connected model
translates these requests into MCP calls. The server itself is not an embedded
LLM or a fixed question router. Client access, configuration and model
permissions vary.

Start stdio directly with `npm start` (waiting silently for MCP input is normal).
For client configurations, invoke Node directly rather than npm so npm banners
cannot contaminate protocol stdout.

#### Local HTTP development

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

### Tools

| Tool | Purpose |
| --- | --- |
| `get_readiness` | Call first: status and the guided next step (what to explain, one question, the next tool) |
| `list_strategies` | Supported plug-ins and versions |
| `preview_strategy` | Validate sample settings without writing or starting |
| `run_sample` | Run synthetic data and save events; idempotent request ID |
| `list_runs` | Read saved sample history |
| `get_run` | Read configuration, decisions and outcome |
| `connect_robinhood` | Start browser authorization; never accepts credentials in chat |
| `wait_for_robinhood` | Wait (up to 40 s a call) for the user's browser approval, so nobody types "done" |
| `get_broker_status` | Check authorization and available read capabilities |
| `check_symbols` | Check proposed tickers: a price and the week-ending expiry the entry rule needs |
| `get_market_quotes` | Read normalized equity prices and freshness flags after authorization |
| `get_levels` | Support and resistance from daily bars: zones and tests, open gaps, trend lines, moving averages. `timeframe: "5y"` measures weekly bars instead. Advisory; market data only |
| `list_accounts` | List your Robinhood accounts as masked labels with opaque handles, so you can choose which to report on. Reads names and status only — no balances, no positions |
| `get_portfolio_report` | Write a printable portfolio report for the accounts you name and return a loopback link to it, plus a short overview the chat can read aloud. Cost basis, market value, unrealized P&L, and the nearest support and resistance for each holding on an expandable chart |
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

No tools execute shell commands, accept arbitrary filesystem paths or submit
brokerage orders. The upstream client enforces two runtime allowlists — six
market-data reads, and the three account reads the portfolio report needs — even
though Robinhood's single scope also advertises order tools. Account reads are
made only when you ask about your accounts, and return masked labels rather than
account numbers. `list_accounts` reads names and status; `get_portfolio_report`
additionally reads balances and equity positions, and is the only tool that
writes any of it down — into the report file itself, created readable only by
you, under `reports/` in Astra's data directory. There is no way to ask for it
somewhere else: a chosen path is how account data ends up in a synced folder.

The report is served on `127.0.0.1` under a name that is minted per report and
not guessable. It is GET-only, serves nothing but reports this process wrote, and
sends `default-src 'none'`, so a page on another origin cannot read it and a path
it did not mint has nothing to traverse to. The link dies with the process.

### Connect Robinhood independently

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

### Complete paper workflow

Use the running MCP server, not the short-lived `connect` diagnostic. Follow the
[end-to-end walkthrough](docs/PAPER-WORKFLOW.md) for exact inputs and expected
results. Discover strategies, authorize Robinhood, configure a supported session
and ticker list, review settings, then explicitly start before 9:32 a.m. New York
time. Ask for positions, daily paper P&L or event history. Ask for a 25% trim or
full close and review the exact whole-contract quantity in your local browser.
Stopping monitoring retains positions; request closes first if that is intended.

The first strategy trades the opening-range breakout: the first two-minute
candle's high and low (optionally including the last two premarket minutes). A
trade above the high buys; a trade below the low first ends the day for that stock,
even if it later rallies. Each entry re-reads the stock first. If that quote is a
later trade back at or below the high, the attempt stops and the stock is watched
again, so a later breakout can still buy while the low holds (`maxEntryAttempts`,
default 3). A quote no newer than the breakout trade stops the attempt the same way
and uses an attempt, but is not counted as a reversal and its price is not judged.
A later quote beneath the low ends the day. New entries stop after a configurable window
(`entryWindowMinutes`, default 90 minutes, i.e. 11:00 a.m. New York time); open
positions are managed all day. Prices are polled about once a second
(`pollSeconds`), so a dip below the low that reverses between polls can be missed.
If the first candle's bars publish late, Astra retries them for up to a minute
(`rangeDeadlineSeconds`) while it keeps watching prices; a trade below the low in
that wait still ends the day, and nothing enters until the range is known. A
stock first seen more than `maxObservationGapSeconds` (default 5) after the first
candle, or unseen for longer than that at any point before an entry, is dropped for
the day rather than assuming a path it did not see.

Premium is treated as money that can be lost entirely, so the caps are the risk
control: by default $2,000 per trade and $4,000 per day (including a $1 per
contract fee reserve), at most two stocks per day. Proceeds never replenish the
budget. Astra buys the strike nearest the stock price where at least four
contracts fit under the cap, then fills up to the cap at that strike, limited by
the contracts displayed at the ask, so how far from the money it lands depends on
the stock's price. Each stock's option catalog loads before 9:32; at an entry
Astra quotes the 20 strikes nearest the price and widens 20 at a time only while
none qualifies (`maxEntryQuoteBatches`, default 3), which finds the same nearest
qualifying strike as quoting every strike would; the journal lists the strikes it
quoted. Strikes the exchange adds during the day are not in that morning catalog. Each of these is a setting you can change when
configuring a run (`maxPremiumPerTradeDollars`, `maxPremiumPerDayDollars`,
`minimumContracts`, `maximumContractsPerTrade`, `maximumPositions`,
`maxOptionSpreadPercent`, `feeReserveCentsPerContract`, `entryWindowMinutes`,
`maxEntryQuoteBatches`, `maxEntryAttempts`, and the exit settings below); a run
keeps the settings it started with.
The expiry is the first week-ending expiration with at least three trading
sessions counting the trade day. In a normal week that means Monday–Wednesday
trades use that week's Friday and Thursday/Friday trades use the following Friday.
Holidays count as non-sessions: when Friday is a holiday the week ends on
Thursday, and a Wednesday before a holiday Thursday or Friday rolls to the next
week. If that expiration is not listed, the stock is skipped for the day rather
than traded in a later expiry.

Exits follow the option's bid, measured against the entry premium: half the
contracts (rounded up) sell at 2×, which recovers the premium; the last contract
sells at 5×; any in between sell at 3×. A bid that jumps past several targets
sells them together. Before the first target, a stock trade below the range low
minus 0.1% sells everything. After it, the stop moves to breakeven: the stock
back at its entry price sells the rest. A simulated Robinhood safety stop sells
everything if the bid falls to 50% of the entry premium (rounded up to a valid
price increment). User trims come out of the nearest unfilled target and never
move the stop. Everything still held sells at the bid `flattenLeadMinutes`
before the close (default 1 minute); contracts that cannot be sold then are
written off as a total loss.
Settings: `firstTargetMultiple`, `middleTargetMultiple`, `finalTargetMultiple`
(each must be higher than the one before), `backstopPercent`, `stopBufferPercent`,
and `flattenLeadMinutes` (default 1, i.e. 3:59 p.m.; new entries also stop then).
An unfilled stop, backstop or close exit stays pending through rebounds and
recovery until a fresh bid fills it.

Simulation assumes fresh ask entry and fresh bid sales, **not executions**. It
does not model queue position, partial fills, market impact or actual fees. P&L
excludes fees; stale marks become unavailable. Polled quotes cannot prove no
unseen intrasecond crossing occurred. A single failed market-data read is only
counted; two in a row are journaled as a `data_gap` (and `data_restored` when it
recovers), and polling continues. The run
halts for inspection only after reads fail for longer than
`readFailureHaltSeconds` (default 60); while it holds positions whose option
prices still arrive, an equity-quote outage does not halt it, so the targets, the
backstop and the close-out keep working. An outage of option prices alone never
halts either: exits wait for a fresh bid (never an invented one), the status shows
`dataGapSince`, and contracts still unsold at the close are written off.

### Replay a past session

`npm run replay -- <date> --fixtures DIR` runs a past session through Astra's own
paper service on a simulated clock. Real minute bars, which you keep privately
(this repository ships none), drive the stock side. Each minute follows open,
low, high, close, so the replay can understate a winner but never invent an entry
the minute does not support. Option prices are **modeled**: Black-Scholes at a
stated volatility (`--iv SYMBOL=0.9`), zero rate, calendar time to expiry, a 4%
spread, and an assumed strike grid within 30% of the day's open. The output marks every modeled number. The
folder `DIR/<date>/` needs a `manifest.json` and `bars-minute-regular.json` with
every regular-session minute for every listed stock; anything missing or partial
is refused, never skipped. `--lag SECONDS` delays bar publication (the range-retry
path). `--check` evaluates the article's day, 2026-09-08: which stock must enter
at its first trade above the opening high, which must lose their opening low
first, and how the exits must end, each claim labeled when modeled prices decide
it, plus late-bar, all-day-window and volatility variants. Journals go to
`DIR/<date>/replay-output` (a new folder per run) unless `--out` says otherwise.

### Persistence and stopping

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
reset budgets. The journal records decisions as they happen (each with the
observation behind it) plus a heartbeat every `heartbeatSeconds` (default 60)
with the latest prices, the price range seen, marks and read failures, so a
session is a few hundred revisions, not one per second. An entry attempt that
stops is journaled as `entry_aborted` when the stock is watched again and
`entry_skipped` when it is done for the day. Both carry the breakout quote that
started the attempt and the entry's own quote, each with its price, trade time and
retrieval time. A run is pinned to the strategy version it was configured under: a
newer version refuses to resume it or configure its run ID again, so configure a
new run ID after upgrading. No automatic deletion policy exists.

The HTTP timer continues after chat disconnection while its process/computer
stay running. **Stdio follows its client's process lifetime.** No launch daemon
or automatic restart is installed. Ctrl-C stops monitoring and checkpoints;
a crash preserves the last committed revision. Reauthorize after restart and
explicitly resume existing positions. Recovery allows no new entries after a
gap. The runner flattens simulated positions one minute before close (a setting);
contracts with no fresh bid by then are written off at -100%, never given an
invented price, exercised or held overnight. Resuming a run after its close only
settles it: contracts it still held are written off the same way. There is no
automatic date rollover. The exchange calendar covers **2026–2027** (NYSE
holidays and early closes); anything outside it is refused, not guessed.

A crash during ownership acquisition can leave an `acquiring` guard. It blocks
automatic recovery for offline inspection. Never repair ownership while another
server might still be running.

### Extension and release roadmap

See [architecture](docs/ARCHITECTURE.md), [security](SECURITY.md) and
[readiness](docs/READINESS.md). Strategy source and historical run records remain
separate. Publishing an update does not activate a strategy or migrate a run.

License selection is pending owner confirmation. Public source alone is not an
open-source license; package publication is disabled until release review.
