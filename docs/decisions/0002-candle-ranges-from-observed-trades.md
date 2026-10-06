# 0002. Candle highs and lows are the extremes of trades Astra observed

Status: accepted, 2026-10-06 (support-box 0.1.0)

## Context

ADR 0001 says what a candle's close is. The support-box strategy also needs each candle's high and low (box height, wicks,
contraction). Astra still polls the last trade about once a second; it has no tick stream.

## Decision

- A candle's high and low are the extremes of the **distinct fresh trades observed** whose trade time falls inside it. A
  trade is bucketed by its own trade time, never by when it was fetched, and the same trade seen on two polls counts once.
- A stale quote never contributes a price (ADR 0001), so it never moves a high or a low.
- A candle seen through fewer than `minCandleTrades` distinct trades (default 3) has an **unknown close** and no rule acts on it
  (`candle_unobserved`, reason `sparse`). Without this an illiquid or briefly frozen stock would show one trade per candle, a
  range of zero, and pass every box test.
- Observed ranges are never wider than the exchange's and are often narrower. A live run can therefore see a tighter box than
  the minute bars show. The journal says its ranges are observed, and an offline scan of minute bars (`scanDay`) is the
  reference, not the live truth.

## What replay does and does not prove

The replay harness drives the live runtime from minute bars along a modeled path (open, low, high, close at 0, 20, 40 and 59
seconds) polled every second, so the observed extremes equal the bar's. The claim "the engine's boxes equal `scanDay`'s"
therefore checks the plumbing (grid, bucketing, ordering, support lookups, journal), not live fidelity. A coarser poll is
expected to differ and shows the claim can fail.

## Rejected alternatives

- **Highs and lows from minute bars for every candle.** Exact, but a read per candle per stock and a publication delay of
  about a minute on every decision; the same reasoning as ADR 0001.
- **Using closes only for box height.** Observable and consistent in both paths, but it hides the wicks the founder's
  "double bottom" is made of. Kept as a candidate if observed ranges prove too noisy.
