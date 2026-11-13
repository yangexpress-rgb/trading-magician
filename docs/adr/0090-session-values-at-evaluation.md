# ADR 0090: Session values are worked out when evaluated; flatten closes at the session's last close

- **Status:** accepted
- **Date:** 2026-11-13
- **Design refs:** design v1.2 N254–N257, O156, O157. Intraday pack brief (2026-11-12),
  requested by Yong.

## Context

Intraday strategies (opening range breakout, VWAP mean reversion, a faithful gap-and-go) need
values anchored to today's regular session: the cumulative session VWAP, the session high and
low so far, and the opening-range high and low. The registry's `vwap` market field is per bar,
and bars-ago windows slide, so none of these could be expressed. They also need a time stop in
minutes and a way to be flat by the close.

The one real fork (brief §10) is where session values come from: worked out when a condition is
evaluated, from the bars the run already holds, or stored as a persisted series.

## Decision

- **Evaluation-time computation.** `MarketView.session(instrumentId, barsBack)` returns today's
  completed regular-session bars of the instrument's finest loaded intraday series (the series
  the run steps on, or a finer one its rules read), as of the current bar or `barsBack` bars
  before it. `sessionValue` in `packages/domain/src/strategy/session-metrics.ts` turns them into
  the five values. The metrics' `requirements` are empty, so they add no plan series, no bars
  to the N232 estimate and no tables. The back test and the paper runtime share `MarketView`,
  so both engines compute them the same way.
- **No lookahead by construction.** Only bars whose end is at or before the current bar's end
  are visible (`MarketView.advance`), and the walk back stops at the session open. Bars outside
  09:30 to the calendar close (13:00 on early closes) never count. A stale series reads unknown,
  as `value` does.
- **Minutes held** reads the clock: whole minutes from the earliest Entry fill to the current
  bar's end (back test) or the pass time (paper). It is a holding value (ADR 0074/0076) that
  needs no closes, so `holdingSeries` skips it.
- **Flatten at session end** is an execution option. The back test closes at the last bar's
  close with the run's slippage, like a market-on-close order: the decision is unconditional,
  so it reads nothing that the fill price could inform. Paper flattens with market orders in
  the session's last five minutes, since an order after the close would wait for the next
  session (O156). The exit reason is `session_end`; migration 0090 widens the
  `backtest_trade` check.

## Consequences

- Session values cost a short walk over today's bars per evaluation (at most 78 five-minute
  bars), cached per series and bar in `MarketView`.
- Persisting a session series was rejected: it would need a table, a writer and backfills for
  every instrument and bar size, and it could drift from the bars the engines step on.
- On paper, session values exist only when the rules read an intraday series (O157); back
  tests always have the run's bars.
- Strategies saved before this change are unchanged: the option is absent (off), and no
  definition migrates.
