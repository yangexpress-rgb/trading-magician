# ADR 0124: State-machine strategies (brief v1.3, Phase P1)

- **Status:** accepted (P1, the three metrics)
- **Date:** 2026-11-27
- **Design refs:** "Trading Magician — State-Machine Strategies: Design Brief" v1.3 (Drive file
  id `1dYuepl_NasusovfWAXfqDjKm37-S87t5`); N381 to N383; open points O259 and O260; no migration.
  Each later phase amends this ADR with its own section.

## Context

The brief adds strategies that hold one named state at a time (T00078-ED, 纳指晴雨, on QQQ) and
switch between target holdings by an ordered, first-match list of rules. Its rules read three
daily metrics the registry does not have. P1 adds only those metrics, independent of the state
machine itself (P2 onwards). Rule A1 holds: no existing metric, indicator or back test changes,
and the A1 reference back tests (ADR 0123) still give the same figures and fingerprints.

## Decision: Phase P1

- **MA slope** (`ma_slope`, N381): SMA(`period`) today ÷ SMA(`period`) `bars` bars earlier − 1.
  Defaults MA20 and 1 bar; period 2 to 500, bars 1 to 250. Empty until both averages exist.
  Stocks, ETFs and indices.
- **Relative volume** (`relative_volume`, N382): today's volume ÷ the mean volume of the `window`
  bars before today; today is left out so a spike is not diluted by itself. Window 2 to 500,
  default 60. Stocks and ETFs only (indices have no volume). On Alpaca IEX bars it measures IEX's
  share of volume, which the help text says.
- **Drawdown from high** (`ath_drawdown`, N383): close ÷ the highest close − 1, 0 on a new high,
  never above 0. `window` > 0 uses the last `window` bars, today's included (`HIGHEST`);
  window 0, the default, uses all loaded history through a new indicator, `HIGHEST_EVER`, a running
  maximum whose look-back is `ALL_HISTORY_BARS` (5,040 bars, 20 years). The existing series
  planner therefore loads from the data start in back tests and on paper alike, with no special
  case in either loader (O259). `HIGHEST_EVER` is hidden from the builder: it is reached through
  the metric. Large groups with window 0 meet the bar limits (O260).
- All three read split- and dividend-adjusted daily bars and only bars up to the one they are
  evaluated on. They reach conditions, group filters and ranking like every registry metric; the
  screener's fixed columns are unchanged.

## Checks

- Each metric against a plain recomputation from the bars, at several dates and parameters
  (`packages/domain/src/strategy/state-machine-metrics.test.ts`).
- A2, no lookahead: every bar after t replaced (a new all-time high, a 50× volume spike) leaves
  each metric's value at t unchanged, for five parameter sets at three dates and three futures.
- The series plan for window 0 starts about 20 years before the run; for window 252 about a year
  and a half (`packages/backtest/src/data.test.ts`).
- A1: the domain, back test, worker and web suites pass unchanged, including
  `a1-reference.test.ts`.

## Consequences

- No schema change and no migration: the metrics are registry entries a saved strategy names.
- P2a (the state-machine form and its evaluation) can build on these metrics.
