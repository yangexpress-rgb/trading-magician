# ADR 0099: Stored 52-week lows and highs, with trading days since

- **Status:** accepted
- **Date:** 2026-11-16
- **Design refs:** design v1.3 §8.7.1, §14.1, §14.2; N290. Requested by Yong on 2026-11-16: "each
  stock 52-week low, and how far back that was from today ... stored in our system ... re-evaluated
  and updated as new data come in."

## Context

The app could already reach a 52-week low inside a strategy (Lowest value of Low over 252 daily
bars) but never showed it, and nothing said how long ago it was set. The screener loads one month
of daily bars, so it had 1-month highs and lows only. Loading a year of bars for every row on each
screen (about 11,000 listings) would cost hundreds of feed requests per screen.

## Decision

- **Definition.** The 52-week low is the lowest daily low of the last 252 regular sessions, today's
  included; the high is the highest daily high. Bars are split-adjusted but not dividend-adjusted,
  as quoted 52-week figures are. "Days since" counts NYSE trading days, like the earnings metrics:
  0 when the latest session set it. A tie counts from the latest session. Under 252 sessions of
  prices gives no figures (unknown, never 0).
- **Stored per stock.** A worker job (`apps/worker/src/price-ranges.ts`) runs every 5 minutes. Once
  a session has closed and settled (30 minutes), it loads 380 calendar days of daily bars for every
  registered US stock and ETF (every built-in group's members, resolved once a day, plus anything
  someone has looked up or charted), 50 symbols per multi-symbol request and 10 batches per pass,
  through the sharing admin's feeds with the background request budget (ADR 0052, 0084). It upserts
  one row per stock into `price_range_52w` (migration 0098): the as-of session, its close, the low
  and high with their dates and days since, and the same for the latest 251 sessions. Global market
  data: the worker login writes it, the app login reads it. A member whose bars stop short of the
  day is asked again after an hour; one with under a year of prices is skipped until the next day.
  Kill switch `PRICE_RANGES=off`.
- **Live during the day.** The 251-session tail lets a page roll the figures forward exactly one
  session with today's prices: the low is the smaller of the tail low and today's low (days since
  - 1 for the tail, 0 for today). The screener does this when its rows are fetched, from each row's
    high, low and last; Price charts do it from the chart's bars for today. Figures two or more
    sessions old are shown as stored, with their date in the tooltip.
- **Screener.** Six columns after the options ones on the wire: 52-week low, Above 52-week low %,
  Days since 52-week low (shown by default), 52-week high, From 52-week high %, Days since 52-week
  high; each is a filter pill, hidden until a row has the figures. New ready-made screen "Within 5%
  of the 52-week low", sorted by days since the low.
- **Price charts.** A line under the symbol's name gives the low and the high, each with its date,
  trading days ago and the price's distance from it.
- **Strategies.** Registry metrics `from_52w_low`, `from_52w_high`, `days_since_52w_low` and
  `days_since_52w_high` (price category, stocks and ETFs) compute the same figures from bars at
  each bar, so back tests stay point in time. They read hidden catalog indicators `LOWEST_AGO` and
  `HIGHEST_AGO` (bars since the window's extreme, one pass with a monotonic queue), which the
  builder does not offer on their own.

## Consequences

- Stocks nobody has looked up are blank on an "All US stocks" screen until someone charts them.
- The daily job adds about 30 to 40 multi-symbol requests per day for ~2,000 stocks.
- A split on the day shows unadjusted for that session until the post-close recompute.
