# ADR 0025: Production operations

- **Status:** accepted
- **Date:** 2026-10-05
- **Design refs:** §16.1, §17.1, §17.2, §17.3, §19.8

## Context

Before inviting anyone (§16.4), the app needs a staging copy to try changes on, limits that hold
when there is more than one web instance, a way to hear about errors and outages without
watching logs, backups that are known to restore, and written steps for the things that go
wrong. Yong approved, on 2026-10-05: Sentry, Railway's logs and an uptime check for monitoring;
a nightly dump to Cloudflare R2 kept 30 days with a monthly restore test. Hosting stays on
Railway (PR #30).

## Decision

- **Two environments.** Railway's `staging` and `production` environments of the same project,
  each with its own Postgres, web, worker and backup services and its own secrets. Staging deploys
  from the branch under test; production from `main`. Stripe stays in test mode in both.
- **Shared rate limits.** The app's per-user limit on changes (120 a minute) moves from process
  memory to Postgres: `rate_limit_hit` increments a fixed-window counter in `api_rate_limit`
  atomically and returns the seconds to wait. The table is reachable only through that function;
  the worker prunes windows older than a day. Better Auth's sign-in limits already use the
  database (`rate_limit`).
- **Logs.** Web and worker write JSON lines through `@tm/observability`'s pino logger, with the
  same redaction list as before (keys, tokens, secrets, credential fields). Railway's log view
  searches them by field. Request bodies and query strings are never logged.
- **Error reports.** With `SENTRY_DSN` set, errors logged at error level with an `err`, unhandled
  API errors, failed page renders (Next's `onRequestError`) and worker crashes go to Sentry. The
  reporter talks to Sentry's envelope API over `fetch` instead of using the SDK, which would need
  build and CSP changes. It sends only the error's type, message and stack, scrubbed of keys,
  secrets, connection-string passwords and email addresses, with service, environment and commit
  tags; the same error is sent at most once a minute and at most 30 a minute in all. Browser
  errors are not reported yet.
- **Uptime.** `GET /api/health` stays a shallow check for Railway's deploys. `GET
/api/health/system` returns 200 only when the database answers and the worker's heartbeat
  (`service_heartbeat`, written every 30 s through `record_heartbeat`, which only the worker may
  call) is under 3 minutes old, else 503. An external monitor polls it every minute.
- **Backups.** A Railway cron service runs `deploy/backup/backup.sh` at 07:30 UTC (after the US
  close): `pg_dump` in custom format, upload to R2, size check, and deletion of dumps older than
  30 days. `restore-check.sh` restores the newest dump into a throwaway database, prints row
  counts and drops it; running it is a monthly runbook step.
- **Runbooks** in `docs/runbooks`: incidents, backups and restore, key rotation, billing
  webhooks, a stuck worker, and feed or broker trouble.

## Consequences

- Every changing request costs one more small database round trip.
- Stored provider keys are sealed to one key pair (ADR 0015), so rotating that pair means people
  enter their provider keys again; the runbook says so.
- The uptime monitor and R2 bucket are accounts Yong creates; their secrets live only in Railway.
