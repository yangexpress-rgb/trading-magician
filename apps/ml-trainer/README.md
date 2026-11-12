# ML trainer

The batch service of the ML prediction signals brief v1 (ADR 0086). It reads the feature
snapshots and realised labels the worker writes (`ml_feature_snapshot`, `ml_label`), refits each
registered model series walk-forward, and writes model runs, frozen predictions, evaluations and
the evaluation report (`ml_model_run`, `ml_prediction`, `ml_evaluation`, `ml_report`). Nothing in
the web app, the worker's trading paths or the back test engine runs a model: they only read
`ml_prediction` through the `ml.score` metric.

## What one run does

`python -m trainer` catches every registered model up:

1. For each prediction date that has snapshots and no active run, in date order (chunked by
   calendar year, each date committed on its own): refit on the cross-sections whose labels had
   fully realised before that date (the embargo; `max_label_end` is recorded on the run and the
   database refuses a run without it), choose ridge alpha by time-series CV inside that window,
   and score the date's members. Dates with fewer than 18 such cross-sections are skipped: the
   first prediction moves later, it never trains on less.
2. Evaluate every run whose date's labels have realised (rank IC, decile spread, coverage).
3. Write the report (`ml_report`, and `$ML_REPORT_DIR/<model>.md` when set).

It is resumable and idempotent: a date with an active run is never rewritten. The historical
backfill (brief §9) and the monthly run are the same command. `--until-year 2020` stops after a
year; `--model mf-ranker-ridge` limits it to one series; `--report` writes the report even when
nothing changed.

## Settings

| Variable              | Meaning                                                                  |
| --------------------- | ------------------------------------------------------------------------ |
| `ML_TRAINER_ENABLED`  | Must be `on`, or the run does nothing (the kill switch).                 |
| `DATABASE_WORKER_URL` | The worker's login (tm_app plus tm_secrets), as the worker service uses. |
| `ML_REPORT_DIR`       | Optional folder for the Markdown report.                                 |

## Deploying on Railway

A fourth service in the project, like the backup job: New → GitHub Repo → this repository, same
branch as the worker. Config-as-code path `/deploy/railway/ml-trainer.json`, or by hand: builder
Dockerfile, path `apps/ml-trainer/Dockerfile`, start command `python -m trainer`, cron
`15 11 * * *` (daily, 06:15 New York; a no-op when nothing is due), restart policy Never.
Variables:

```text
DATABASE_WORKER_URL=postgresql://tm_worker_login:${{shared.DB_WORKER_LOGIN_PASSWORD}}@${{Postgres.PGHOST}}:${{Postgres.PGPORT}}/${{Postgres.PGDATABASE}}
ML_TRAINER_ENABLED=on
```

## Tests

```sh
pip install -r apps/ml-trainer/requirements-dev.txt
cd apps/ml-trainer && python -m pytest
# With a migrated database (pnpm --filter @tm/db db:migrate), the database tests run too:
ML_TEST_DATABASE_URL=postgres://owner:password@localhost:5432/db python -m pytest
```
