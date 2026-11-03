# ADR 0029: Price charts in Quantitative Research

- **Status:** accepted
- **Date:** 2026-11-03
- **Design refs:** §7.1, §9.2, §11

## Context

The Quantitative Research tab was reserved for a later release. Its first tool is the one every
research workflow starts from: pick a stock or ETF and look at its prices. Bars for real
instruments come from the person's data feed, whose API key only the worker can open (ADR 0015),
so the web app cannot fetch them itself.

## Decision

- **Which stocks.** The picker lists the instruments the tenant can already pick in a strategy:
  the demo instruments, plus real US stocks and ETFs it looked up or uses (ADR 0017). It filters by
  symbol or name as the person types. A new symbol is found with the same lookup as the strategy
  editor, and is charted as soon as the worker registers it. Requests for any other instrument are
  refused, so one tenant cannot learn about another's lookups.
- **A queued chart, like a lookup.** The web app inserts a `price_chart` row (instrument, range,
  interval, and the New York dates they cover) and polls it. The worker claims pending charts with
  `claim_price_charts`, asks for bars through the tenant's bars route (`createRoutedHistory`, the
  same path back tests use), and stores them on the row as compact
  `[startMs, open, high, low, close, volume]` tuples with the feed's name and warnings. Rows are
  tenant-isolated with the usual policy. A ready chart from the last 5 minutes, or one still
  pending, is reused for the same request. Claiming also deletes charts older than a day: they are
  a cache of provider data, not a record.
- **What is drawn.** Ranges are 1W, 1M, 3M, 6M, 1Y and 5Y of calendar time ending today in New
  York. Daily bars are offered for all of them; hourly bars only up to 3 months, which keeps a chart
  to a few hundred bars. Bars are split-adjusted, regular session, and only finished bars are shown
  (ADR 0007). Prices are numbers on the wire because they are only drawn, never computed with.
- **The chart.** A price pane (closing line by default, or candles) above a volume pane on the
  same time axis. Bars are spaced evenly, so nights, weekends and holidays leave no gaps. Rising
  candles are hollow and falling ones filled, so direction never rests on colour. A crosshair
  follows the pointer, or the arrow keys when the chart has focus, and the readout above it shows
  that bar's values; the same values are in a table. The selection lives in the address, so a chart
  can be bookmarked and survives a reload. The data feed that answered is named under the chart.

## Consequences

- A chart takes one worker round trip (about a second) the first time it is asked for.
- Alpaca's free IEX feed covers one exchange, so its volumes are lower than the whole market's; the
  feed's own warning says so beneath the chart.
- Screens, formulas and sending assets to the Strategy Lab (§11) remain to be built on top.
