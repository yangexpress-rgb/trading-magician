# ADR 0042: Indicator-only instruments and the CBOE index feed

- **Status:** accepted
- **Date:** 2026-11-06
- **Design refs:** §6.4, §9.2, §13.5; design v1.2 item 5, rows N30 to N33; refines ADRs 0016, 0017, 0038

## Context

Some strategies watch a volatility index and trade something else: "buy SPY when the VIX closes
above its upper Bollinger band". The condition engine could already read one instrument and trade
another, but the VIX could not be added at all. Instrument search found only tradable US stocks and
ETFs, and searching "VIX" offered VIX-futures ETFs (VIXY, UVXY), which are different things with
different values. The v1.2 brief (item 5) asks for an instrument kind that can be watched but not
traded, CBOE's free end-of-day history as its feed, and a BandWidth function.

## Decision

- **An instrument kind.** `instrument.kind` is `tradable` (every instrument so far) or
  `indicator_only` (migration 0056). Indices get their own asset class, `index`, so that the
  existing routing by asset class (ADR 0016) sends their bars to an index feed; a check constraint
  ties the two together (`asset_class = index` exactly when `kind = indicator_only`), so code can
  ask either. The domain helper is `isIndicatorOnlyClass`.
- **What an indicator-only instrument can do.** Conditions, ranking metrics (the price metrics now
  list `index`) and calculated expressions may read it. No leg may trade it, no Selection-group
  universe may hold it, and no broker account trades the `index` asset class. Validation says so
  in the builder with the instrument's name (`instrument_not_tradable`), and also asks for daily
  bars and the close (`index_daily_only`), since that is all the feed has. As with every other
  validation problem the draft still saves; the error blocks back tests and Start.
- **Finding it.** The app knows its indices (`INDEX_LISTINGS` in `@tm/domain`, the VIX for now).
  An instrument lookup whose text names one ("VIX", "CBOE Volatility Index") registers it through
  `register_instrument` as `index` on venue `CBOE`, with no stock feed needed, and never falls
  through to the stock feed's search. Pickers show it with the badge "Index — not tradable"; a leg's
  picker and a Selection group's list leave it out.
- **The CBOE feed.** Provider `cboe` ("CBOE index history (daily)") needs no key. It downloads
  `cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv` (daily OHLC since 1990), keeps
  it in the worker's memory for six hours (one download serves every tenant; a stale copy is used
  while CBOE is unreachable), and answers daily bars only: no intraday bars and no live prices.
  Providers can now say which data they are routed for (`dataTypes`); CBOE is routed for bars
  alone, so adding it makes one `index` bars route. The worker's feed checks download the file.
  Tests use a made-up file (`CBOE_FAKE=true`).
- **Calendar alignment.** Each CBOE row becomes a bar spanning that day's NYSE regular session,
  exactly like a stock's daily bar. A value published on a day the NYSE was closed is dropped (with
  a warning). A trading day CBOE has no value for has no bar; the engine reads an indicator-only
  series as "the latest bar ending at or before now", so that day uses the most recent VIX close on
  or before it. Indicator-only series never make other series look stale, never set the back-test
  clock, get no execution series, and are not watched for live prices by the paper runtime.
- **BandWidth.** `BANDWIDTH(x, n, multiplier)` = (upper − lower) / middle, a statistic function
  beside the Bollinger ones, on any expression, with the same population deviation; unknown when
  the middle is 0.

## Consequences

- A VIX close is CBOE's end-of-day value, which settles at 16:15 New York time, a quarter hour
  after the stock close it is aligned with. A strategy deciding at the stock close therefore sees a
  value published slightly later; this is the usual end-of-day convention and is said in the bars'
  warning.
- The brief's motivating "volatility squeeze" rule (BandWidth at its lowest in 120 bars) needs the
  lowest value of an expression, but the existing LOWEST takes only a price field. That is open
  point O18, proposed for item 7, which revisits HIGHEST and LOWEST.
- The real CBOE download has not been run from the cloud container, whose network does not reach
  cdn.cboe.com; it is checked on Yong's Mac or staging when the feed is added.
