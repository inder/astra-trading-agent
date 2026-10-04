# 0001 — Live chart: polling upstream, streaming to the page, SQLite history

Status: accepted (2026-10-04)

## Context

Users want a chart of any ticker with a daily panel and an intraday candle panel
that updates while the market is open, zooms, and keeps history while left open.
Astra reaches Robinhood only through its MCP connection and a read allowlist.

## Decisions

1. **Polling upstream, server-sent events to the page.** Robinhood's MCP answers
   requests and offers no stream. Robinhood's app uses a private websocket, but
   reaching it would mean leaving the read allowlist, which is the security
   boundary. So one loop polls `get_equity_quotes` (a single batch for every
   charted symbol) during the regular session and pushes to every open page.
   Prices are up to ~2 s behind by construction.
2. **A second loopback server, not a route on the report server.** It needs JSON
   and an event stream, so it accepts the page's own `Origin` (the report server
   refuses every `Origin`). Keeping it separate leaves the report server's
   stricter rules intact. It applies the same Host check plus `Sec-Fetch-Site`,
   because another loopback port is same-site.
3. **TradingView Lightweight Charts (Apache-2.0), bundled into the page.** Chosen
   over extending the report's hand-drawn SVG: wheel zoom, panning and live
   candle updates come with it. It is inlined from `node_modules` under a
   hash-pinned script policy, never fetched. Same version as the Market
   Internals branch.
4. **Minute history in SQLite (`node:sqlite`), not JSON files.** Built into Node
   24, so there is no new dependency. Official Robinhood bars always replace
   quote-built provisional ones, enforced in one SQL statement. A session counts
   as stored only after a read made after its close. Kept 90 days by default.

## Consequences

- Every automatic action (reloads, per-symbol fallback, retries) is rate-limited:
  three review rounds found the loops that otherwise appear.
- `node:sqlite` is experimental in Node 24 and prints one warning when a chart
  first opens; it is confined to `src/chart-store.ts`.
- The chart's reads share the Robinhood connection with paper runs.

Refs: docs/LIVE-CHART.md.
