# ADR 0030: Stock screener in Quantitative Research

- **Status:** accepted
- **Date:** 2026-11-03
- **Design refs:** §9.2, §11

## Context

After charting one stock (ADR 0029), the next research tool is finding stocks: every stock and
ETF the data feed covers, with its key values side by side, narrowed and sorted by any of them.
Prices for the whole US market only come through the person's data feed, whose key only the
worker can open (ADR 0015).

## Decision

- **Which stocks.** With a real US stock feed (Alpaca), every active, tradable US stock and ETF
  listed on NYSE, Nasdaq, NYSE Arca, NYSE American or Cboe BZX: about 11,000 from the asset list
  already cached for name search. Over-the-counter names are left out, because the IEX feed has
  no prices for them. Without a real feed, the demo instruments from the demo feed.
- **A queued screen, like a chart.** The web app inserts a `stock_screen` row and polls it; the
  worker claims it with `claim_stock_screens`, asks the feed, and stores one compact tuple per
  symbol on the row with the feed's name, the session date and warnings. A pending screen, or a
  ready one from the last minute, is reused; Refresh asks again. Claiming deletes screens older
  than an hour: they are a cache of about a megabyte, not a record. Rows are tenant-isolated.
- **Alpaca.** Two kinds of request, 200 symbols at a time and 3 in flight, retried with backoff
  when throttled: multi-symbol snapshots (latest trade, today's and yesterday's daily bars) for
  every screen, and a month and a half of split-adjusted daily bars, kept in the worker per key
  for the day (at most 2 hours). About 110 requests for the first screen of the day, 55 after.
- **S&P 500 by default.** With a real feed the screen opens on the S&P 500 members, with a
  switch to every US stock and ETF; the demo feed opens on its own instruments. Alpaca does not
  say which index a stock is in, so the member list (with each member's GICS sector) ships with
  the app in `@tm/domain`, generated from the public-domain dataset at
  github.com/datasets/s-and-p-500-companies by `pnpm --filter @tm/domain sp500:update`. The
  screen shows the list's date. A screen is asked for one universe (`sp500` or `all`): the S&P
  500 alone is about 6 requests and loads in seconds, so the page shows it at once, and the
  whole market (about 13,000 listings, 130 requests) is screened only when the person switches
  to it. Rows of the whole market already cover the S&P 500, so switching back needs no load.
  A Sector column and filter cover the members.
- **Partial answers.** A batch Alpaca still cannot answer after four tries is left blank, with a
  warning saying how many stocks are missing, instead of failing the screen; only when every
  batch fails, or the key is refused, does the screen fail. Daily history is cached per symbol,
  so a later screen fetches only what is missing.
- **Demo.** Finished daily bars, and today's session so far from its finished 5-minute bars.
- **Values.** Worked out once, in the domain (`screenRow`), for every feed. "Today" is the
  latest session any symbol has prices for (today's once the market opens, the last one on a
  weekend or holiday) and "yesterday" the one before; a symbol that has not traded today has no
  today values. Columns: last price, today's change $ and %, open, high, low, volume, $ volume,
  yesterday's close and change %, opening gap %, today's range %, 5-day and 1-month (21
  sessions) change %, 1-month high and low and the distance from each, 20-session average
  volume, and relative volume (today so far against that average).
- **Screening in the browser.** All rows are sent once and filtered and sorted in the page, so
  changing a filter never waits on the server. Each value column has min and max boxes (amounts
  like 250k or 1.5M), and every heading sorts; there is a text filter, type, exchange, a few
  ready-made screens (gainers, losers, most active, unusual volume, gaps, 1-month highs), a
  column picker and CSV download. Filters, sorting and columns live in the address. A symbol
  opens its price chart, looked up first when it is not registered yet.

## Consequences

- The first screen of the day takes tens of seconds for the whole market; later ones a few.
- IEX volumes are a few percent of the market's, so volume filters and the "liquid" threshold
  in ready-made screens are lower on Alpaca's free feed; the warning says so under the table.
- The S&P 500 list changes a few times a quarter; it is as current as the last
  `sp500:update` run, and the screen says when that was.
- Fundamentals (market cap, P/E) came later from company data feeds (ADR 0031). Custom
  formulas (§11) are not offered yet; they can build on the same rows.
