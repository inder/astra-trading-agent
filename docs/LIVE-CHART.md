# Live chart

Ask "chart RDDT" and Astra returns a loopback link (`open_chart`). The page has a
ticker box for charting another stock, and two panels:

- **Daily**: settled daily candles from Robinhood, the 10/21/50/200-day moving
  averages, and the support and resistance zones `get_levels` computes. QTD, YTD
  and 2Y zones come from daily bars; 5Y zones come from weekly bars, and the page
  says so. While the market is open, today's candle is built from today's minute
  bars and moves with them.
- **Intraday**: candles from Robinhood's 1-minute bars, switchable to 2, 5, 15 or
  30 minutes. Larger candles are rolled up from the 1-minute bars and aligned to
  the 9:30 ET open, so a 30-minute candle is 9:30–10:00, and it can never disagree
  with the minutes inside it. Times are Eastern.

Both panels zoom with the scroll wheel (centred on the pointer) or the +/−
buttons, pan by dragging, and Reset returns to the timeframe (daily) or the latest
session (intraday).

## How "live" works

Robinhood's MCP connection answers requests and offers no streaming feed, so the
updates are polling upstream and streaming to the browser:

```
Robinhood ──(Astra polls get_equity_quotes every 2 s, one read for every charted symbol)──► Astra
Astra ──(server-sent events)──► every open chart page
```

- Each poll folds the latest regular-session trade into its minute's candle. A
  poll sees the last trade, not every trade, so that candle is **provisional**.
- Every 60 s Astra re-reads today's official 1-minute bars. Robinhood's bar
  replaces the provisional one for every minute that ended at least a minute ago;
  newer minutes stay with the quotes, because Robinhood marks its newest bar
  unsettled and how soon a finished minute's bar appears is unmeasured.
- If Robinhood refuses the shared quote batch, Astra asks for each symbol on its
  own (at most every 30 s, so a rate limit is not met with more reads). A symbol
  that fails while others answer leaves the batch, so one mistyped ticker cannot
  stall every chart; its page shows it as stale. It is asked for alone again every
  refresh and rejoins the first time it answers; after a second failure in a row
  its page says to check the ticker. A page whose ticker has no Robinhood data
  does not ask for live prices at all, and retries its load at most three times.
- A page left open into the next session reloads itself when that session starts.
- Polling runs only during the regular session and only while a page is open. The
  page shows `Live · <time>`, `Market closed`, or `Prices stale` (and dims the
  charts) when no quote read has succeeded for 15 s.
- Ten symbols can be charted live at once by default; Robinhood's quote batch takes
  twenty at most.

Gap-fill bars (`interpolated: true`, minutes nobody traded in) are hidden, as
Robinhood's own guidance recommends, and pre- and post-market bars are left out.

## History

Minute bars are stored in `charts.sqlite` in the data directory (Node's built-in
SQLite; no extra dependency). The first time a symbol is charted, Astra fetches
the last five sessions it does not already hold in full. A session counts as held
only once its bars were read after it closed: a chart closed at 11:00 leaves the
morning behind, and that day is read again in full later. A single minute-history read is
kept to five days or less: a five-day read was captured working and a thirty-day
read failing (2026-10-04). After that, the store keeps whatever the chart sees, for
90 days by default, so the intraday panel can scroll back further than one read
returns.

Every number above (poll and refresh intervals, sessions fetched, retention,
symbol cap, stale threshold) is a validated setting with a default in
`src/live-chart.ts` (`chartSettingsSchema`). They are not yet user-configurable:
the service runs the defaults, as it does for the levels settings.

## Limits

- **Up to ~2 s behind**, by construction: polling, not a tick feed.
- **Regular session only.** Pre-market and after-hours trades never move a candle.
- **Shares the Robinhood connection with paper runs.** The chart adds one quote
  read per poll and one bar read per symbol per minute.
- **Evidence:** the bar parser is built against captured Robinhood replies
  (`test/fixtures/robinhood-minute-*.json`). Polling, candle building, the store
  and the page are tested with invented prices and in real browsers (Chromium,
  WebKit, Firefox). Live updating during market hours still needs an attended
  check.
- `node:sqlite` is flagged experimental in Node 24 and prints one warning to
  stderr the first time a chart opens.
