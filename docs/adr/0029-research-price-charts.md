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
- **Search by ticker or company name.** One search box filters the stocks the person has and,
  through their data feed, searches every US stock and ETF. A lookup tries what was typed as a
  ticker first; when nothing trades under it, or it cannot be a ticker (it has spaces), the worker
  searches the provider's listings by symbol and name and stores the closest few on the lookup as
  candidates, unregistered. Picking one looks it up by its ticker as before. For Alpaca the list of
  active US equities (about 12,000) is downloaded once and kept in memory for 6 hours; it is
  public reference data, so one copy serves every tenant, and each search still needs the
  tenant's own working key. Without a real-provider feed the box says how to add one.
- **A queued chart, like a lookup.** The web app inserts a `price_chart` row (instrument, range,
  interval, and the New York dates they cover) and polls it. The worker claims pending charts with
  `claim_price_charts`, asks for bars through the tenant's bars route (`createRoutedHistory`, the
  same path back tests use), and stores them on the row as compact
  `[startMs, open, high, low, close, volume]` tuples with the feed's name and warnings. Rows are
  tenant-isolated with the usual policy. A ready chart from the last 5 minutes, or one still
  pending, is reused for the same request. Claiming also deletes charts older than a day: they are
  a cache of provider data, not a record.
- **What is drawn.** Ranges are 1D, 1W, 1M, 3M, 6M, 1Y and 5Y. 1D is the latest trading
  session with bars (today's while the market is open; the last one on a weekend or holiday);
  the others are calendar time ending today in New York. 5-minute bars are offered for 1D and 1W,
  hourly for 1D to 3M, daily from 1W up; 1D opens on 5-minute bars. That keeps a chart to a few
  hundred bars. Bars are split-adjusted, regular session, and only finished bars are shown
  (ADR 0007). Prices are numbers on the wire because they are only drawn, never computed with.
- **5-minute bars.** Alpaca gives them directly (`5Min`). The demo history splits each hourly
  bar into 5-minute bars with a seeded Brownian bridge from its open to its close, touching its
  high and low and sharing out its volume, so they always add up to the hourly bar and never
  change. Back tests and strategies can now read 5-minute demo bars too.
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
