# ADR 0117: ML training on the Local Companion, and the push inbox

- **Status:** accepted
- **Date:** 2026-11-25
- **Design refs:** design v1.3 §17.4; N339 to N341; migration 0113. S2 plan step 3, first part
  (3a). Yong said "yes go ahead" on 2026-11-25 after step 2 (#240).

## Context

Step 3 of the S2 plan runs the ML trainer and the pattern miner on the companion and sends their
Frozen Outputs up (A5). The trainer reads Core (the model registry, which dates are served) and
writes Core (`ml_model_run`, `ml_prediction`) and the Research Store (evaluations, reports). Core
writes need the worker's login (`tm_secrets`); the web app, which the companion talks to, has only
`tm_app`, which may read model runs and predictions but never write them. Step 3 is split: 3a (this
ADR) is ML training; 3b moves the factor and feature writers; 3c moves pattern mining.

## Decision

- **A local mirror, so the trainer runs unchanged.** The companion's local database holds
  `ml_model`, `ml_model_run` and `ml_prediction` beside the Research Store tables. Before each
  training pass it mirrors the cloud's registry and every active run with its predictions
  (`GET /api/companion/v1/ml/state`, `GET …/ml/runs/<id>/predictions`), marks those dates frozen,
  and runs `python -m trainer` with Core and Research pointed at the same local database. The
  trainer's code, embargo and walk-forward protocol do not change.
- **A one-way inbox.** The companion pushes what it made (`POST /api/companion/v1/pushes`, kinds
  `ml_run` with its predictions, `ml_evaluation`, `ml_report`), each with its own client key so a
  repeat is the same push. The web app checks the payload and that the pairing is the producer's
  (O216), and only stores the push in `companion_push` (migration 0113), as the person. The worker
  applies waiting pushes every minute with its own login: it checks again that the pairing stands
  and belongs to the producer, then writes the run (keeping the companion's run id, so the
  evaluation pushed later points at it), its predictions and the frozen-date marker, or the
  evaluation or report in the Research Store. A refused push records why and is not retried; the
  companion lists refusals (`GET …/pushes?open=1`).
- **Never rewritten.** A prediction date with an active run in the cloud is not touched: the push
  is recorded as "date already served", and at the next mirror the cloud's run replaces the local
  one. Database rules (the embargo check) still apply and refuse a bad run.
- **Time and source (A5).** `ml_model_run` gains `source` (`cloud` or `companion`) and
  `source_detail` (e.g. "Local companion 0.2.0 (darwin-arm64)"). The strategy builder's `ml.score`
  note now says when the latest scores were made and by whom.
- **Python.** Until S3 bundles a runtime, the companion makes a virtual environment in its data
  folder from the computer's Python 3.12+ (`TM_COMPANION_PYTHON` names another) and installs the
  trainer's pinned requirements once.

## Consequences

Nothing changes while no producer companion pushes: the cloud trainer keeps running until the
hand-over (step 4). If both run, whichever serves a date first wins and the other gives way, so
no date is ever served twice. The web app still cannot write model runs. The companion trains on
what its local Research Store holds: until 3b (writers) or Yong's data move (step 5), that is
nothing, and a pass is a no-op.
