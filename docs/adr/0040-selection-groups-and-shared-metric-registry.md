# ADR 0040: Selection groups, per-leg conditions and a shared metric registry

- **Status:** accepted
- **Date:** 2026-11-06
- **Design refs:** v1.2 §2.2 rows N1–N16, §6.4–§6.9, §7.3, §13.2; extends ADR 0006 (definition document), ADR 0007 (evaluator)

## Context

The v1.2 change list (P0, items 1–4) asks for strategies that pick what to trade at run time:
rank a universe and hold the top N, fire only the leg whose own condition holds, compare
statistics of a calculated spread, re-evaluate on a calendar, and exit after N days held. Its
principles require one evaluation engine for preview, back test and paper, one implementation
per metric, null instead of 0 for missing data, and v1.1 strategies that run unchanged.

## Decision

- **Everything is an optional field on the existing definition document** (`entry.kind`,
  `entry.selection`, `entry.fireMode`, `legCondition`, `exit.rules`, `schedule`, and the `metric`
  and `stat` expression kinds). v1.1 definitions parse and canonical-hash as before. The SPY
  strategies' back-test results were pinned (`packages/backtest/src/regression.test.ts`) before
  any of this code and are unchanged.
- **Metric registry** (`packages/domain/src/strategy/metrics.ts`): each metric has an id,
  parameters, the asset classes it supports, the daily series it needs (for bar loading) and a
  `compute` that reads those series bars back. Conditions, ranking and fire mode call the same
  `computeMetric`. Values are fractions; no value is `undefined`, which the evaluator's
  three-valued logic treats as unknown.
- **Statistics evaluate their input bar by bar** in the shared evaluator (`statValue`), reading
  the input expression at increasing offsets; series needed for that are loaded with the offset
  inflated by the period (`definitionSeries`). `BB_*` use the population deviation so they
  equal BBANDS; `STDDEV`/`ZSCORE` use the sample deviation.
- **Slots.** A Selection group member or a conditional leg is a _slot_ `{legId, instrumentId}`
  with at most one cycle. `slotDefinition` gives the definition a slot's cycle runs (its leg bound
  to its instrument, quantity split by N for a selection, the Exit legs for that instrument), so
  the existing cycle machinery (`planCycle` at runtime, the back-test cycle) runs unchanged.
  The nil UUID stands for "this instrument" and is bound with `withContext`. `rankUniverse`,
  `selectLegs` and `planSlots` decide entries and rebalance exits, and both the back tester and
  the paper runtime call them.
- **Schedule** uses the NYSE calendar already in `market/calendar.ts`: `scheduledPeriod` returns
  a period at most once, after the close of the period's last trading day; the runtime stores the
  last period in its state. Exits and the time stop (`timeStopReached`, trading days since the
  first Entry fill) run every bar.
- **S&P 500 is back test only for now — an open decision, not settled.** As built,
  `paperRunBlocker` stops Start for a built-in universe or a list over 50. Yong has not confirmed
  this limit (design v1.2 N13, O17); it stays until he decides. Back tests resolve members through the feed's asset list
  (`apps/worker/src/universes.ts`) and warn about survivorship bias.
- **Results** keep up to 400 selection rounds in the run result (`selections`) and an exit reason
  per trade (`backtest_trade.exit_reason`, migration 0052).

## Consequences

- One code path for every mode, so a rule cannot back test one way and paper trade another.
- Trigger options don't apply to slot strategies; validation requires one cycle at a time and
  concurrent submission for them.
- A 503-member back test loads 503 series; it is slow on first run. The screener does not use
  the registry yet (design v1.2 O1).
