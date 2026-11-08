# ADR 0048: Options in Research, the screener and rankings

- **Status:** accepted (its expected-move exit was built later, ADR 0053)
- **Date:** 2026-11-07
- **Design refs:** §6.4, §6.10, §9.2, §11, §13.6, §16.4; design v1.2 rows N60 to N66, open points
  O42 to O47; options data brief v2 (Phase 2, §10 items 8 to 11). Builds on ADR 0047 (end-of-day
  options signals), 0030 (stock screener), 0031 (company pages in Research) and 0040 (metric
  registry)

## Context

Phase 1 (ADR 0047) records each session's option chains and turns them into end-of-day signals that
strategy conditions read. Yong passed it on review and asked for Phase 2: a Research Options section
backed by an on-demand live chain with a 15-minute cache, options columns in the screener, ranking
and fire mode by options metrics, and the docs and help text, with the "exit beyond the expected move
at entry" rule built only if it fits cleanly.

## Decision

- **The live chain is a global cache, asked for through a definer function.** Migration 0065 adds
  `option_live_chain`: one row per symbol (status pending, ready or failed; the stored view; the
  chain file's time). The app login reads it and asks for a chain only through
  `request_option_chain(symbol)`, which re-queues a symbol whose view is older than 15 minutes, or
  whose failure is older than a minute, and refuses past 50 waiting chains. The chain is public data,
  so the cache has no tenant and one person's request serves everyone for 15 minutes. The app checks
  that the person has the options feed on before asking. Rows unasked for a day are deleted.
- **The worker prices the chain itself.** A worker loop (every 2 seconds, up to 3 chains a pass)
  claims waiting symbols, fetches the CBOE file, takes the file's own underlying price (the last
  Alpaca close when the file has none), the FRED rate and the stock's dividend yield, and runs the
  Phase 1 pricing (`computeChain`) and derive (`deriveSignals`) steps. IV rank and percentile use the
  recorded IV30 history when the symbol is recorded. Any US stock or ETF can be asked for, recorded or
  not; the live chain does not add it to the recording. The loop runs whether or not
  `OPTIONS_RECORDING` is on.
- **The view holds only the app's numbers.** Per expiry: days to go, ATM IV and strike, 25-delta put
  and call IV, volume and open interest totals, and per strike the computed IV, delta and gamma with
  open interest, volume and dollar gamma per 1% move; also gamma and open interest by strike over
  every expiry, the figures row (every daily signal field) and the inputs used. Strikes within 30% of
  the price and expiries up to 400 days are kept; the figures use the whole chain. Bids, asks, last
  prices and CBOE's own IV and greeks never enter the view, so no screen can show them.
- **Research › Options** sits between the price chart and Company for stocks and ETFs: the figures
  row with each metric's registry help, an expiry picker, IV smile, term structure, open interest and
  gamma by strike (this expiry or all), the recorded IV30 history with rebuilt days in a lighter
  dashed line, and the chain table of computed values. Under it: the feed's name, the chain time and
  the pricing inputs, with Cboe's attribution. A Refresh button asks again once the 15 minutes pass.
- **The expected-move cone** is drawn on daily price charts: from the last close, ± one standard
  deviation at each expiry's ATM IV out to 60 days, one slot per trading day. On intraday charts a
  link switches to 3 months of daily bars; a checkbox hides it.
- **Screener columns** IV30 %, IV rank, Expected move 1 week %, IV / realised vol, Skew (vol points),
  Term structure and Put/call OI come from the latest recorded signal (at most 5 trading days old,
  as strategies read it), filled in when the screen's rows are fetched, not stored with the screen.
  They need the options feed on, cover recorded underlyings only, and are hidden until a row has one;
  they filter, sort and export like every other column.
- **Ranking and fire mode** accept every registry metric, options metrics included
  (`metric_not_rankable` is gone). Members or legs then load their signals like condition reads; a
  member without a signal ranks as unknown and is left out ("no value"). A list universe ranked by an
  options metric needs each member recorded (`missing_options_feed` names it; saving adds it).
- **The expected-move exit is left out.** Exiting "beyond the expected move at entry" needs the
  expected move captured when each cycle enters and kept with it in back tests and on paper, as the
  ATR stop keeps its ATR (ADR 0045). That is a change to the cycle state, the engine, the paper
  runtime and the exit builder, not a fit within this phase. Today's nearest rule is "Position gain %
  > Expected move, 5 days (%)", which compares with the current expected move, not the one at entry.

## Consequences

- Showing the app's computed chain is a wider display than Phase 1's "derived signals only"; the
  Cboe terms review on the launch gate now covers the Research section too.
- The live chain shares CBOE's CDN with the daily recording; the 15-minute cache and the 50-chain cap
  keep request volume small.
- An S&P 500 Selection group ranked by an options metric ranks only the recorded members; the rest
  read "no value" until the recording grows.
