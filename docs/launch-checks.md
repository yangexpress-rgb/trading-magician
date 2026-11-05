# Launch checks

The record for the invite-only, paper-only launch (pre-launch punch list, design v1.1
deviations D9 and D10). Each row says what was done, where, when, and the result. A row is only
"passed" when its acceptance check was seen to pass, not when code for it was merged.

Status on 2026-11-05: code for every item is merged or in review; nothing below has run against
a deployment yet, because no Railway environment exists.

## Section 1. Invite administration audited (D6)

| Date       | Environment                            | What was done                                                                                              | Result                                                                                                                         |
| ---------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 2026-11-05 | Test database, owner without superuser | `invites:mint 3 "D6 acceptance batch"`, claimed one code, `invites:release <code> "D6 acceptance release"` | Passed: `invite.minted` (count 3, note) and `invite.released` (count 1, note, invite id); no code found in `audit_event::text` |
| 2026-11-05 | CI and local                           | Full unit, integration and e2e suites on PR #61                                                            | Passed; merged into main at 4829733                                                                                            |

## Section 2. Credential key out of the environment

| Date       | Environment | What was done                                                                                             | Result                                                                                   |
| ---------- | ----------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 2026-11-05 | Unit tests  | Value sealed by today's web code opened through a KMS stand-in (same format) and still by the PEM key     | Passed                                                                                   |
| _pending_  | staging     | Add an Alpaca paper key in Settings, restart the worker, feed check still passes; no private-key variable | Needs an AWS account with the KMS key, and Railway staging (AWS KMS approved 2026-11-05) |

## Section 3. Recovery objectives and restore drill

RPO 24 hours, RTO 4 hours: see `docs/deploy.md`, Recovery objectives. The drill table is in
`docs/deploy.md`, Restore drill.

| Date       | Environment | What was done                                                                         | Result                                |
| ---------- | ----------- | ------------------------------------------------------------------------------------- | ------------------------------------- |
| 2026-11-05 | Container   | Rehearsed `backup.sh` and `restore-check.sh latest` against an S3-compatible stand-in | Scripts work unchanged; not the drill |
| _pending_  | staging     | Restore newest scheduled R2 backup into a clean Postgres, start web, sign in          | Needs Railway, R2                     |
| _pending_  | staging     | Deliberate failure: remove worker deployment, monitor emails                          | Needs uptime monitor                  |

## Section 4. Observability and backups

| Check                  | Code side (2026-11-05)                                                                                                                                                                      | Live check                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Sentry DSN from config | Web and worker read `SENTRY_DSN`; `pnpm --filter @tm/worker sentry:test` sends a deliberate error and reports Sentry's answer (tried against a local stand-in: HTTP 200, envelope received) | _pending_: needs Sentry account   |
| Uptime endpoint        | `https://<web domain>/api/health/system`: 200 when database and worker heartbeat are fine, else 503                                                                                         | _pending_: needs monitor, staging |
| Scheduled R2 backups   | `deploy/railway/backup.json`, daily 07:30 UTC, 30 days kept, size-checked upload                                                                                                            | _pending_: needs R2, Railway      |

## Section 5. Railway staging and production

| Step                                                                      | Result                    |
| ------------------------------------------------------------------------- | ------------------------- |
| Staging created, variables set, migrations current, services start        | _pending_: needs Railway  |
| Smoke test: sign up, sign in, strategy, back test, paper run, Orders      | _pending_                 |
| Production created from staging, `/api/health` shows `liveTrading: false` | _pending_ (after 6 and 7) |

## Section 6. k6 load test (staging only)

Targets (Phase 6 plan, `load/README.md`): 20 people x 5 strategies, 10 back tests at once, page
and API p95 under 1 s, checks 100%, paper orders submitted within 5 s of their trigger.

| Date      | Staging configuration | Profile | Page p95 | API p95 | Checks | Orders p95 | Misses and likely cause |
| --------- | --------------------- | ------- | -------- | ------- | ------ | ---------- | ----------------------- |
| _pending_ |                       |         |          |         |        |            |                         |

## Section 7. Real-provider checks (paper credentials only)

| Date      | Environment | Provider      | What was done                                                                                                                       | Result |
| --------- | ----------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------ |
| _pending_ | staging     | Alpaca data   | Feed connected in Settings › Data feeds; live price and bars for a stock and an ETF                                                 |        |
| _pending_ | staging     | Alpaca orders | Small paper order placed in the app, seen at Alpaca and in Orders; cancelled in the app, cancellation seen on both sides (ADR 0018) |        |
| _pending_ | staging     | SEC EDGAR     | SEC feed added in Settings; a company opened in Research shows filings and data                                                     |        |

Any difference between a real provider and its fake becomes a fixture change plus a test that
fails on the old behaviour; list them here with the PR.

## Section 8. Launch gate

Send no invite until every line is ticked.

- [x] D6 closed (Section 1)
- [ ] No credential master key in production variables (Section 2)
- [ ] RPO and RTO written down (done) and a staging restore from the real backup path succeeded
- [ ] Sentry receives errors, uptime monitor green, scheduled backups exist (Section 4)
- [ ] Production on Railway with the paper-only guard confirmed (Section 5)
- [ ] k6 report against staging on record, misses explained (Section 6)
- [ ] Alpaca data, Alpaca place-and-cancel and SEC EDGAR checks recorded (Section 7)
- [ ] Full test suite passes on the production build
- [ ] Invites capped at 20 (`invites:list` shows at most 20 minted)
- [ ] Stripe in test mode (the apps refuse a live key; check Variables)
