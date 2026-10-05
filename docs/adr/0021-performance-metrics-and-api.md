# ADR 0021: Performance metrics and API

- **Status:** accepted
- **Date:** 2026-10-05
- **Design refs:** §10.1, §10.2, §11, §14.3

## Context

The Performance tab needs one set of figures for any mix of filters (§10.1), and §10.2 asks that
each be defined. A back test and a paper run should be measured the same way. Yong approved the
Phase 5 defaults on 2026-10-05: accounts return a daily time-weighted return on equity; strategies
show dollars and a return on the most capital they had at work; one trade is one strategy cycle.

## Decision

- **One metrics module.** Drawdown, Sharpe, time-weighted return and trade statistics live in
  `@tm/domain` (`performance/metrics.ts`); the back-test engine uses the same functions.
- **Sources.** Daily series come from the stored valuations (ADR 0020), so a chart is reproducible;
  trades come from the ledger (ADR 0019). A session a book or account was not valued carries its last
  value forward.
- **Account view** (no strategy, version, instrument or asset-class filter): equity is the sum of the
  accounts' app equity. Returns, drawdown and Sharpe are measured on a growth index that chains each
  session's return, with an account's starting equity counted as money brought in on its first
  session, so adding an account is not a gain. Sharpe is annualised over 252 sessions with a zero
  risk-free rate and is not shown under 20 sessions; the summary says when history is that short.
- **Filtered view:** account equity does not apply, so the series is P&L in dollars, drawdown is in
  dollars from the running peak, and return is net over peak capital.
- **Peak capital** is the most cost basis held on any session in range, or a single cycle's capital
  if that is larger. Return on peak capital is net over it.
- **P&L over a range** is the cumulative figure at the range's last session less the one before its
  first: realized net plus unrealized, less fees paid on open lots.
- **Trades** belong to the session they closed in (opened in, while open). Win rate, profit factor,
  average, best and worst count closed cycles.
- **API.** `GET /api/v1/performance/summary`, `/timeseries` and `/trades` take the same filters:
  `from` and `to` (session dates, inclusive), and repeatable `accountId`, `strategyId`, `versionId`,
  `instrumentId`, `assetClass`, plus `mode` (`paper` by default). Live mode returns empty results
  until live trading exists. Money is USD with two decimals.
- **Data quality** in the summary: when the account was last valued, how many open holdings carry a
  stale or missing price, and every flagged close with both sides' figures.

## Consequences

- Figures lag fills by up to one valuation interval (5 minutes by default); the summary says when
  the account was last valued.
- Deposits and withdrawals at a real broker are not tracked yet, so they show as equity differences
  with the broker rather than as flows.
