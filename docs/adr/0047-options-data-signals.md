# ADR 0047: End-of-day options signals from CBOE delayed chains

- **Status:** accepted; ranking, fire mode and the display of computed values changed by ADR 0048; the Alpaca key falls back to the admin's feed (ADR 0050)
- **Date:** 2026-11-07
- **Design refs:** §6.4, §6.10, §7.2, §7.3, §8, §9.2, §13.2, §13.6, §16.4; design v1.2 rows N50
  to N59, open points O32 to O41; options data brief v2 (Phase 1). Builds on ADRs 0040 (metric
  registry), 0042 (CBOE index feed and its display-terms flag) and 0043 (point-in-time fundamentals)

## Context

Yong asked for options data as an input to stock and ETF strategies: how far the market expects
an underlying to move in the short term and how options are positioned, never which way it will
move, and never options trading. The options data brief v2 settles the source (CBOE's delayed
quotes CDN, not Alpaca's indicative feed), the formulas, the fixtures and the build order; this
ADR records how it was built and the choices the brief leaves open.

## Decision

- **Global recording, stored once.** Option chains are public data, so they are recorded once for
  everyone, like company filings. Five tables (migration 0064): `option_universe` (the underlyings
  recorded, with their recording and rebuild status), `option_contract`, `option_chain_snapshot`
  (one row per contract per day: CBOE's quote and greeks, plus the app's own IV, delta and gamma),
  `option_daily_signal` (one row of derived values per underlying per day) and
  `option_expiry_signal` (ATM IV, straddle and 25-delta IVs per expiry). Only the worker's login
  writes them. Contracts and snapshots are worker-only (row-level security, no app access); the
  universe and both signal tables have no tenant column and the app login may read them, as the
  instrument table.
- **Universe.** The seed list (SPY, QQQ, DIA, IWM, AAPL, MSFT, NVDA, AMZN, META, GOOGL, TSLA, AMD,
  NFLX, AVGO) is registered through the app's Alpaca key when missing and added each day; any US
  stock or ETF a saved strategy uses is added when the strategy is saved (`add_option_underlyings`,
  a security-definer function that accepts only real stocks and ETFs). Nobody adds one by hand.
- **Daily recording.** From 16:45 New York on each NYSE day (until the next open) the worker
  fetches `CBOE_OPTIONS_URL/{SYMBOL}.json` for each underlying: 20-second timeout, two retries per
  request, and one more attempt 30 minutes after a failed fetch; after that the day is missed and
  the failure is shown in the universe status, never filled from older data. The **stale-file
  guard** refuses a file stamped before the previous trading day's close; a file stamped before
  the day's own close is stored with a note. Rows with a negative bid, an ask below the bid, a
  negative IV or gamma, a delta outside −1 to 1, or anything unparsable are skipped and counted.
- **The app computes its own IV and greeks.** CBOE's IV and greeks are stored but never used.
  Black–Scholes–Merton with continuous dividend yield; IV by Newton's method with a bisection
  fallback on 0.0001 to 5; out-of-the-money options only (an in-the-money contract takes the IV of
  the same strike's out-of-the-money side); a quote is usable when bid > 0, ask > bid and the spread
  is at most 40% of the mid. Inputs: the underlying's Alpaca daily close (unadjusted, the same close
  back tests use), the risk-free rate from FRED's 3-month bill (DTB3, the latest on or before the
  day), and the stock's point-in-time dividend yield from its stored filings (0 for ETFs and for
  stocks without filings). Without a close or a rate the snapshot is stored and the signal waits for
  the next pass, up to 10 days.
- **Derived signals.** Per the brief §4: IV30 (variance interpolation to 30 days between the
  expiries either side, each at least 2 days out), ATM IV, expected moves for 1 and 5 days in
  percent and dollars, the straddle move, IV rank and percentile over 252 trading days (unknown
  under 120 days of history), IV ÷ 20-day realised volatility (the registry's own volatility
  metric), 25-delta skew at 30 days, term structure, put/call volume and open-interest ratios, and
  gamma exposure (call, put and net, dollars per 1% move, with the dealer-positioning assumption
  stated in its help text). Call wall, put wall and max pain are stored for Phase 2 but are not
  condition metrics. Missing inputs make a value unknown, never zero.
- **History rebuild.** Once per underlying, the worker rebuilds daily signals back to February
  2024 (or the retention window, whichever is later) from Alpaca's daily option bars through the
  app's key: Friday and monthly expiries 2 to 75 days out, strikes within 15% of the close, closes
  of contracts that traded at least 10 times that day priced like mids. Rows are stored with
  `source = 'rebuilt'` and `feed = 'alpaca_bars'`, never replace a recorded day, and have no
  open-interest, quote or volume signals (bars carry none). Ranks of recorded days are recomputed
  afterwards. Without an app Alpaca key, or when the bars aren't available, the underlying's
  rebuild waits and IV rank warms up over 120 recorded days instead.
- **Retention.** `OPTIONS_HISTORY_DAYS` (default 400) prunes snapshots and signals older than the
  window every day, rebuilt rows included (Yong confirmed 400 days, 2026-11-07).
- **Strategy metrics.** The registry gains an `options` category: `options.<field>` for every
  signal above except the three open-interest levels. Each reads the underlying's latest signal
  whose day has closed by the bar's time (`signalAvailableFrom`: that session's close) and that is
  at most 5 trading days old; otherwise it is unknown. Back tests and paper runs share this through
  `MarketView.option`. Ranking and fire mode refuse options metrics (`metric_not_rankable`) until
  Phase 2.
- **Validation and runs.** A strategy using an options metric needs an options data feed on
  (`missing_options_feed`, naming the feed to add) and each named underlying in the universe
  (`missing_options_feed`, naming the symbol; saving adds it). A back test whose dates are all
  before a named underlying's first signal fails with "No options data for SPY before <date>"; one
  that overlaps reports, per underlying, how many bars had a signal and how many read rebuilt
  history. The condition log records the as-of date of each signal read, marked "(rebuilt)" where
  it applies.
- **The feed.** "CBOE delayed options (daily)" (`cboe_options`) is a keyless feed kind of its own in
  Settings › Data feeds, with no routes. It turns the recording on for the tenant's strategies; its
  health is Down once no underlying has been stored for 3 trading days running.
- **Display terms.** `CBOE_OPTIONS_DISPLAY_TERMS` records that the delayed chains are for internal
  use: no screen shows a chain, quote or greek; users see only the app's derived values as strategy
  inputs. The terms review for a paid service, and the question whether Alpaca's terms allow
  rebuilt values from the app's key to be shown to other users, are on the launch gate.
- **Configuration.** Worker variables: `CBOE_OPTIONS_URL`, `OPTIONS_RECORDING` (on or off, default
  on), `OPTIONS_HISTORY_DAYS`, `OPTIONS_ALPACA_KEY_ID` and `OPTIONS_ALPACA_SECRET_KEY` (both or
  neither: the app's own paper key, for closes, the rebuild and registering seed symbols, because a
  global recording can't use one tenant's key), `FRED_CSV_URL`, and `CBOE_OPTIONS_FAKE` for tests
  (refused in production).

## Consequences

- Options data starts the day the recording runs; before that, back tests have none, and only the
  rebuild gives earlier (approximate) history.
- A daily back test reads a day's signal at that day's close, although the chain is fetched at 16:45
  and reflects about 16:30; paper runs see it on the first pass after it is stored. Intraday bars
  never see a day's signal before that day's close.
- The cloud build machine can't reach CBOE, Alpaca's data host or FRED, so the endpoints and file
  format were built from the brief and tested against stand-ins; the first real check is on the Mac.
- Phase 2 (Research Options section, screener columns, ranking and fire mode, the expected-move
  exit) can read the same tables without a schema change.
