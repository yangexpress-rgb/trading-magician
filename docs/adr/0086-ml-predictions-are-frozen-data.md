# ADR 0086: ML predictions are frozen data; training lives outside the engines

- **Status:** accepted
- **Date:** 2026-11-12
- **Design refs:** design v1.2 rows N239 onwards (ML prediction signals); open points O149
  onwards. Yong's brief "Machine-learning prediction signals — design brief v1" (2026-11-12).
  Follows the pattern of ADR 0047 (options signals) and ADR 0058 (event data).

## Context

Yong asked for machine learning in the one form that can be back tested honestly: a model
scores each stock on each rebalance date, and strategies rank and filter by that score as they
rank by momentum or options skew. The first series is a cross-sectional multi-factor ranker for
the S&P 500 that learns how to weight factors the app already computes. Success is correctness:
no look-ahead, scores readable and rankable in the builder, and every pick traceable to the model
run that produced it.

## Decision

- **Predictions are data, not code.** A model never runs inside the web app, the worker's trading
  paths or the back test engine. Training and scoring live in a separate batch service
  (`apps/ml-trainer`, Python 3.12, scikit-learn) that reads snapshots from Postgres and writes
  rows. Everything downstream is TypeScript reading those rows, the way `option_daily_signal`
  rows are read.
- **Global tables, migration 0088.** `ml_model` (one row per series, seeded with
  `mf-ranker-ridge`), `ml_model_run` (one per refit), `ml_feature_snapshot`, `ml_label`,
  `ml_prediction`, `ml_evaluation` and `ml_report`. Only the worker login (`tm_secrets`) writes;
  the app login reads models, runs, predictions, evaluations and reports.
- **Immutable by the database.** Triggers refuse UPDATE and DELETE on `ml_prediction`,
  `ml_label` and `ml_evaluation`, even for the owner. A model run may only change from active to
  superseded; a bad run is superseded and a new run written, never edited. At most one active run
  serves a model's prediction date. Snapshots for a date freeze once any prediction exists for it.
- **The embargo is recorded and enforced.** Every run stores `max_label_end`, the last date any
  training label finished realising, and a check constraint requires it to be before the
  prediction date. A training row (t) is used for prediction date T only when t + 21 trading days
  is before T.
- **Features come from the app's own point-in-time paths.** The worker's snapshot job computes
  each feature through the shared metric registry and the back test's market view (daily bars,
  the EDGAR point-in-time replay, the events store), so a feature equals what a condition would
  have read that day. The trainer never recomputes a feature.
- **`ml.score` reads like an options signal.** The latest prediction dated on or before the bar
  (visible from that date's close), no more than 45 calendar days old; superseded runs are never
  read; a member without a current score is left out of a ranking as "no value". Prediction reads
  add no bar series to a back test and do not count toward the N232 bar cap.
- **Provenance on the cycle card.** Each condition check and each ranked pick that reads
  `ml.score` stores the score's date, the model key, the run number and that run's training end.
- **Kill switch.** The trainer runs only with `ML_TRAINER_ENABLED=on` (off until Phase 1
  acceptance), like the earnings-calendar kill switch.

## Alternatives

- **Train inside the back test** (walk-forward refits during a run). Makes every back test slow
  and makes leakage a property of engine code rather than of stored, checkable rows. Rejected.
- **A TypeScript trainer.** No Python at runtime, but the model classes worth using (ridge with
  proper scaling now, gradient-boosted rankers later) are immature in TypeScript, and the
  language boundary costs nothing when the service only reads and writes tables. Rejected.
- **Per-user model series.** Phase 1 is platform series only (open point).

## Consequences

- A score is only as fresh as the monthly cadence: `ml.score` is for monthly or quarterly
  strategies, not intraday use.
- The universe is today's group members, so survivorship bias applies to ML results at least as
  much as to the factor strategies.
- Retraining never silently changes a strategy: new runs append new predictions; old back test
  results keep the values they recorded.
- The trainer is a fourth Railway service (or a scheduled job) with the worker's database login.
