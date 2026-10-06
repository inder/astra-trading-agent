# 0001. Candle rules act only on closes Astra observed

Status: accepted, 2026-10-04 (strategy 0.10.0)

## Context

The founder replaced the opening-range strategy's single-trade rules with candle closes: before entry, a 2-minute
candle closing a range height under the opening low cancels the setup; after entry, a 2-minute close under the day's
low sells. Astra sees prices by polling the last trade about once a second. It has no tick stream and no live candle
feed, and Robinhood's minute bars publish seconds to about a minute late.

## Decision

- A candle's close is the last trade Astra **observed** before the candle's end, built from the quotes it already
  polls. It is labelled an observed close, not the exchange's official close.
- A close counts only when a **fresh** quote (at most `maxQuoteAgeSeconds` old) was seen within
  `maxObservationGapSeconds` of the candle's end. A candle settles only when a trade at or after its end is seen, or a
  fetch lands `maxQuoteAgeSeconds` past it, so a trade delivered late still counts.
- A stale quote can mark a candle as ended but never supplies or vouches for a price. A quiet stock, a lagging feed
  and a frozen feed look the same from here.
- When a close is unknown, no rule acts on that candle and the journal says `candle_unobserved`. The option-price
  safety stop still protects an open position.

## Rejected alternatives

- **Reading minute bars for every close.** It is exact, but it adds a read every two minutes per stock and delays every
  cancel and stop by the bars' publication lag. It remains the candidate fallback for open positions on thin names
  (founder option B, not chosen for now).
- **Treating an unknown close as a sell.** A feed hiccup would close a good position. Rejected.
- **Inferring the close from the last known price across a gap.** It contradicts the invariant that an unseen price
  path is never assumed.

## Consequences

A stock that has not traded in roughly the last 10 seconds of a candle gets no close for that candle (with the default
settings). On the liquid names studied so far (2026-09-08 and 2026-09-14, ten stock-days), no candle went unobserved.
Replays judge the same rules against minute bars (`<symbol>-cancel`, `-stop`, `-stop-due` claims), so engine and bars
are held to one answer.
