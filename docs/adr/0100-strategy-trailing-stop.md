# ADR 0100: A strategy trailing stop in Risk limits

- **Status:** accepted
- **Date:** 2026-11-16
- **Design refs:** design v1.3 §8.11, §12.3; N291. Requested by Yong on 2026-11-16 ("add one more
  risk limit for each strategy: Trailing Stop %"), default 1%. Yong chose on the same day to
  measure it on the whole strategy, close every position when it fires, and give the 1% default to
  existing strategies too.

## Context

Exit when already offers a per-stock trailing stop ("Off best close since entry %", N217,
ADR 0074), but nothing caps how much a strategy as a whole gives back from its best once it is in
the market. Yong wants each strategy to lose no more than about 1% from its best performance after
entry, as a risk limit that every strategy has.

## Decision

- **N291: `risk.trailingStopPct`**, shown in Risk limits as "Trailing stop (%)". Optional; new
  strategies start at 1% (`DEFAULT_RISK`); blank means none.
- **What it measures** (`stepStrategyTrail`, `packages/domain/src/execution/strategy-trail.ts`,
  shared by the back test and paper). Tracking starts when the strategy goes from flat to holding
  and ends when it is flat again. It keeps the highest strategy equity seen while holding (paper
  capital, cash and holdings at their marks) and the largest gross position value in that time
  ("the money in its positions"). It fires when equity is more than the limit % of that money below
  the best. Equity is used rather than the positions' market value so that buying more is not a
  gain and taking profit on part of a position is not a loss. For one stock bought once, 1% fires
  when the position has given back 1% of its value from its best.
- **What happens.** Every position the strategy holds closes with market orders, the same way as
  Flatten at session end (N256): legs not yet sent are dropped, working orders are canceled, and
  cycles with nothing filled yet stop entering. The cycle's exit reason is
  `strategy_trailing_stop` ("Trailing stop (whole strategy)"). Until the strategy is flat again no
  new Entry is placed; then tracking starts afresh and the strategy keeps running (it is not
  paused). On paper a notification "Trailing stop reached" says by how much, and the firing is
  audited (`runtime.strategy_trailing_stop`). The state lives in the runtime state
  (`strategyTrail`); it is judged only when every holding has a mark.
- **Back test.** Checked at each bar's close after the loss limits; when it fires every cycle closes
  at that bar's close with the run's slippage, and Entry firings on that bar are logged as stopped
  by the trailing stop. The run says so in its warnings.
- **Existing strategies: schema 6.** `migrateV5` adds `trailingStopPct: '1'` to any stored
  definition read from schema 5 or older without one (stored versions are never rewritten). A
  strategy saved from schema 6 on keeps what it says, blank included. Running strategies pick it up
  on the first pass after deploy, starting from their value at that pass.
- **Migration 0099** adds `strategy_trailing_stop` to the `backtest_trade` exit-reason check.

## Consequences

- It is a trigger level, not a guaranteed maximum loss: prices are seen once per pass or bar and
  the closing orders are market orders, so a fast move or an overnight gap loses more than the
  limit before they fill. In back tests the close fills at the bar's close, which is kinder than
  paper.
- 1% of the money in positions is tight for daily-bar strategies; ordinary daily moves will fire
  it. People can widen or blank it per strategy.
- The back-test corpus (`corpus.test.ts`) and engine fixtures drop the limit so they keep checking
  every other rule exactly as before; the stop has its own tests in domain, back test and worker.
