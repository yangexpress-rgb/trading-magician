# Deploying to Railway

The app runs as three Railway services in one project: **Postgres**, **web** (Next.js) and
**worker** (back tests, paper runtimes, feed and broker checks, valuations). Web and worker
build from the same `Dockerfile`; their start commands live in `deploy/railway/web.json` and
`deploy/railway/worker.json`.

Every web deploy first runs migrations, the seed (a no-op unless `DEMO_DATA=on`, which only
the tests set and which Railway ignores; ADRs 0039, 0046) and `db:setup-logins` (the
`preDeployCommand`). All three are safe to repeat. Railway runs that command without a shell,
so it is wrapped in `sh -c '…'`; without the wrapper only the migration runs and the database
logins are never created (the worker then logs `password authentication failed for user
"tm_worker_login"`).

### If Railway will not take the config file path

When staging was first built (2026-11-06), Railway refused the config-as-code paths below. If
that happens, set the same values by hand in each service's Settings; they are what
`deploy/railway/*.json` hold:

| Setting            | web                                                                                                               | worker                           | backup                                 |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- | -------------------------------- | -------------------------------------- |
| Builder            | Dockerfile, `Dockerfile`                                                                                          | Dockerfile, `Dockerfile`         | Dockerfile, `deploy/backup/Dockerfile` |
| Pre-deploy command | `sh -c 'pnpm --filter @tm/db db:migrate && pnpm --filter @tm/db db:seed && pnpm --filter @tm/db db:setup-logins'` | none                             | none                                   |
| Start command      | `pnpm --filter @tm/web start`                                                                                     | `pnpm --filter @tm/worker start` | `backup.sh`                            |
| Health check       | `/api/health`, timeout 120 s                                                                                      | none                             | none                                   |
| Restart policy     | On failure, 5 retries                                                                                             | Always                           | Never; cron `30 7 * * *`               |

Paper trading only, as everywhere else (`docs/adr/0002-paper-only-guard.md`).

## What you need

- A Railway account on the Hobby plan, with GitHub connected so it can see this repository.
- Optional: a Resend account for sign-up and password-reset emails, and one API key from it.
  Until you verify a domain with Resend, it only delivers to the address you signed up to
  Resend with, so that is the only address that can finish signing up. Without a mail service,
  set `EMAIL_VERIFICATION=off` on web instead (see [No mail service](#no-mail-service)).
- Four random strings of letters and digits, at least 32 characters each (a password manager's
  generator works). They are only ever pasted into Railway.

## Steps

1. **Create the project.** In Railway, choose New project → Deploy PostgreSQL. Rename the
   database service to `Postgres` if Railway named it differently.

2. **Shared variables.** Project Settings → Shared Variables. Add:

   ```text
   DB_APP_LOGIN_PASSWORD=<random string 1>
   DB_AUTH_LOGIN_PASSWORD=<random string 2>
   DB_WORKER_LOGIN_PASSWORD=<random string 3>
   ```

3. **Web service.** New → GitHub Repo → this repository. Name the service `web`. In its
   Settings:
   - Source: set the branch to deploy.
   - Config-as-code: set the path to `/deploy/railway/web.json`. Railway no longer accepts
     this path on new services (it asks for `.railway/railway.ts` instead). If it refuses,
     copy the settings from `web.json` into the service by hand: Dockerfile path `Dockerfile`,
     the pre-deploy command, start command, health check `/api/health` with a 120 s timeout,
     and restart on failure. Keep the pre-deploy command wrapped in `sh -c "…"`: Railway runs
     it without a shell, so a bare `a && b && c` only runs `a`.
   - Networking: Generate Domain.

   In Variables, open the Raw Editor and paste:

   ```text
   DATABASE_URL=${{Postgres.DATABASE_URL}}
   DB_APP_LOGIN_PASSWORD=${{shared.DB_APP_LOGIN_PASSWORD}}
   DB_AUTH_LOGIN_PASSWORD=${{shared.DB_AUTH_LOGIN_PASSWORD}}
   DB_WORKER_LOGIN_PASSWORD=${{shared.DB_WORKER_LOGIN_PASSWORD}}
   DATABASE_APP_URL=postgresql://tm_app_login:${{shared.DB_APP_LOGIN_PASSWORD}}@${{Postgres.PGHOST}}:${{Postgres.PGPORT}}/${{Postgres.PGDATABASE}}
   DATABASE_AUTH_URL=postgresql://tm_auth_login:${{shared.DB_AUTH_LOGIN_PASSWORD}}@${{Postgres.PGHOST}}:${{Postgres.PGPORT}}/${{Postgres.PGDATABASE}}
   APP_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}
   BETTER_AUTH_SECRET=<random string 4>
   SMTP_URL=smtps://resend:<Resend API key>@smtp.resend.com:465
   MAIL_FROM=Trading Magician <onboarding@resend.dev>
   AUTH_IP_HEADERS=x-real-ip
   ```

   Without a Resend key, leave out `SMTP_URL` and `MAIL_FROM` and add `EMAIL_VERIFICATION=off`.

   `AUTH_IP_HEADERS` tells the sign-in rate limits which header holds the visitor's address
   (ADR 0004). Railway's edge sets `X-Real-IP`; check one request's headers after the first
   deploy, and if it is missing use `AUTH_TRUSTED_PROXIES` with the proxy's address range
   instead. Without either, every visitor shares one sign-in limit.

4. **Worker service.** New → GitHub Repo → the same repository, same branch. Name it
   `worker`. Config-as-code path: `/deploy/railway/worker.json` (if Railway refuses it, set the
   start command `pnpm --filter @tm/worker start` and restart policy Always by hand). No domain.
   Variables:

   ```text
   DATABASE_WORKER_URL=postgresql://tm_worker_login:${{shared.DB_WORKER_LOGIN_PASSWORD}}@${{Postgres.PGHOST}}:${{Postgres.PGPORT}}/${{Postgres.PGDATABASE}}
   ```

   Add the credential key variables from [Credential key (AWS KMS)](#credential-key-aws-kms) as
   well, once that key exists. Never set `CREDENTIALS_PRIVATE_KEY` on Railway: the worker refuses
   to start with it there.

   The worker restarts until the web service's first deploy has created its database login.

5. **Mint your own invite code.** Sign-up is invite-only (ADR 0026), so make a code before you
   try to sign up. From a checkout with `DATABASE_URL` pointing at the Railway database:

   ```sh
   pnpm --filter @tm/db invites:mint 1 "me"
   ```

   Railway's database is private by default. Either run this inside the web service
   (`railway ssh -s web -- sh -c 'cd /app && pnpm --filter @tm/db invites:mint 1 "me"'`), or add
   a TCP proxy to Postgres for a moment, use its public URL, and delete the proxy straight after.

   Codes are printed once. `invites:list` shows how many are left, and
   `invites:release <code> [note]` frees one that was claimed but never used. Each mint and
   release writes an `invite.minted` or `invite.released` audit event with the count and note,
   never the code (ADR 0034). To see them:
   `select occurred_at, action, context from audit_event where user_id is null order by 1;` To let anyone sign up without a code, set
   `SIGNUP_MODE=open` on web; keep it unset in production.

6. **Deploy and sign up.** Deploy both services, open the web domain, and sign up with your
   Resend address, using the code you minted. The verification email arrives from
   `onboarding@resend.dev`. With `EMAIL_VERIFICATION=off`, sign-up takes you straight in.

### No mail service

`EMAIL_VERIFICATION=off` on web makes the app work without any email: sign-up signs the person
straight in, and no verification or password-reset email is sent. The invite code is the only
gate on who can sign up (web refuses to start with it and `SIGNUP_MODE=open`). Nobody can reset
a forgotten password themselves; the operator does it (ADR 0036):

```sh
railway ssh -s web -- sh -c 'cd /app && pnpm --filter @tm/web users:reset-password person@example.com'
```

It prints a temporary password once and signs the person out everywhere. Give it to them over a
channel you trust; they sign in and change it in Settings › Security. Staging uses this. Decide
for production before inviting anyone.

### Admin page

The app has an admin page at `/admin` (ADR 0037) for testers, invite codes, password resets,
system health and the audit log. Make yourself an admin once, after signing up:

```sh
railway ssh -s web -- sh -c 'cd /app && pnpm --filter @tm/db users:grant-admin you@example.com'
```

An **Admin** tab then appears under Settings in the side bar. `users:revoke-admin` takes it
away. Admins can lock and unlock people (locking signs them out everywhere and refuses sign-in),
reset passwords, create, revoke and release invite codes, and read the whole audit trail.

## Staging and production

Railway environments keep two full copies apart (ADR 0025). **Staging comes first**: the steps
above build it, and production is made from it only after staging has passed the smoke test, the
load test (`load/README.md`) and the real-provider checks (`docs/launch-checks.md`).

1. Build staging with the steps above in an environment named `staging` (Project Settings →
   Environments → New Environment → **Empty**, then add Postgres, web, worker and backup to it).
   It gets its own Postgres, its own KMS key, its own R2 prefix and Stripe in test mode. No
   production data and no real person's credentials ever go into staging.
2. Optional for staging only: `SIGNUP_PLAN=pro` on web, so test sign-ups skip checkout, and
   `EMAIL_VERIFICATION=off` if staging has no mail service.
3. Once staging passes, Project Settings → Environments → New Environment → **Duplicate**
   `staging`, name it `production`. Railway copies the services and variable names.
4. In production, set every random string and key again with **new** values: shared variables,
   `BETTER_AUTH_SECRET`, a second Stripe webhook endpoint pointing at production's domain and its
   secret, production's own KMS key ARN and IAM access key, `CREDENTIALS_PUBLIC_KEY` from that
   key. Never share a secret between the two. Remove `SIGNUP_PLAN` and keep `SIGNUP_MODE` unset.
5. Point staging at the branch you want to try; keep production on `main`.
6. Check production: the home page loads over HTTPS, `/api/health/system` is 200,
   `/api/health` answers `"liveTrading": false` (the ADR 0002 paper-only guard, a compile-time
   constant plus database CHECK constraints; asking for live mode anywhere fails with "Live
   trading is not enabled in this build"), and the worker log shows `credential key loaded` with
   `source: aws-kms`. Run `pnpm --filter @tm/db db:migrate` against production's `DATABASE_URL`
   once more and check it applies nothing.

### Production must not contain

`CREDENTIALS_PRIVATE_KEY`, `SIGNUP_PLAN`, `SIGNUP_MODE=open`, `PAPER_CLOCK_START`, `ALPACA_FAKE`,
`SEC_FAKE`, `CUSTOM_REST_FAKE`, `BILLING_FAKE`, or any Stripe key that does not start with `sk_test_`/`rk_test_`
(the apps refuse a live Stripe key). Check the Variables tab of web and worker before inviting
anyone.

## Credential key (AWS KMS)

Stored provider keys (Alpaca) are sealed with a key whose private half lives in AWS KMS and never
leaves it (ADR 0035). Do this once per environment (staging, then production):

1. In the AWS console, KMS → Customer managed keys → Create key: **Asymmetric**, key usage
   **Encrypt and decrypt**, key spec **RSA_3072**, alias `tm-credentials-<environment>`. Copy its
   ARN.
2. IAM → Users → Create user `tm-worker-<environment>`, no console access. Attach an inline
   policy allowing only `kms:Decrypt` and `kms:GetPublicKey` on that key's ARN. Create an access
   key for it.
3. Worker variables:

   ```text
   CREDENTIALS_KMS_KEY_ID=<key ARN>
   AWS_REGION=<the key's region, e.g. us-east-1>
   AWS_ACCESS_KEY_ID=<tm-worker access key id>
   AWS_SECRET_ACCESS_KEY=<tm-worker secret>
   ```

4. Print the key's public half and give it to web:

   ```sh
   CREDENTIALS_KMS_KEY_ID=<key ARN> AWS_REGION=<region> AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… \
     pnpm --filter @tm/worker credentials:kms-public-key
   ```

   Set web's `CREDENTIALS_PUBLIC_KEY` to the PEM it prints (all lines). The fingerprint it prints
   must match `keyId` in the worker's `credential key loaded` log line.

5. Check: add an Alpaca paper key in Settings, restart the worker (Deployments → Restart), and
   confirm the feed check still passes. Then confirm neither service has a
   `CREDENTIALS_PRIVATE_KEY` variable.

Local development keeps using `pnpm --filter @tm/db credentials:keygen` and
`CREDENTIALS_PRIVATE_KEY`; that variable is for development only.

## Monitoring

- **Error reports (Sentry).** Create a free Sentry account and a Node project, copy its DSN
  (Settings → Client Keys), and add `SENTRY_DSN=<dsn>` to web and worker in each environment.
  Reports are tagged with the Railway environment and commit. To check it works, send one
  deliberate error with the worker's own settings and look for "Deliberate Sentry test error" in
  Sentry:

  ```sh
  railway run --service worker --environment staging pnpm --filter @tm/worker sentry:test
  ```

- **Uptime check.** In an uptime service such as Better Stack or UptimeRobot (free tiers are
  enough), add an HTTP monitor for `https://<web domain>/api/health/system` every minute,
  alerting by email when it is not 200 for 2 checks in a row. It answers 200 with
  `{"status":"ok",…}` when the database answers and a worker heartbeat is fresh, and 503
  otherwise, so it turns red when the database or the worker is down. (`/api/health` is the
  lighter check Railway's deploy uses; it does not look at the worker.)
- **Deliberate-failure check** (do it once in staging after the monitor is green): remove the
  worker's deployment (worker → Deployments → ⋯ → Remove). Within about 2 minutes
  `/api/health/system` answers 503 and the monitor should email you. Note when the email arrived,
  then redeploy the worker and check the monitor goes green again.
- **Logs.** Railway's Logs tab per service; lines are JSON, so filter by field, e.g. `@level:50`.

## Backups

1. **R2.** In Cloudflare → R2, create a bucket (e.g. `tm-backups`). Under Manage R2 API tokens,
   create a token with Object Read & Write on that bucket only. Note the access key id, secret
   and the S3 endpoint `https://<account id>.r2.cloudflarestorage.com`.
2. **Backup service.** New → GitHub Repo → this repository, same branch. Name it `backup`.
   Config-as-code path: `/deploy/railway/backup.json` (a daily cron at 07:30 UTC). Variables:

   ```text
   DATABASE_URL=${{Postgres.DATABASE_URL}}
   R2_ENDPOINT=https://<account id>.r2.cloudflarestorage.com
   R2_BUCKET=tm-backups
   AWS_ACCESS_KEY_ID=<R2 token access key id>
   AWS_SECRET_ACCESS_KEY=<R2 token secret>
   ```

   Dumps go under `<environment name>/` in the bucket and are kept 30 days.

3. Run it once by hand (the service's Cron Runs → Run now) and check the log ends with
   `backup: done`. Then follow `docs/runbooks/backups.md` for the monthly restore test.

Retention: one dump a day at 07:30 UTC, kept 30 days (`BACKUP_KEEP_DAYS`), under
`<environment>/tm-<time>.dump` in the bucket. Staging and production use the same bucket with
different prefixes, or one bucket each.

## Recovery objectives

For the invite-only, paper-trading launch (up to 20 people, one operator):

- **Recovery point objective (RPO): 24 hours.** The newest R2 dump is at most a day old (daily at
  07:30 UTC). Anything after it is lost: strategies edited, back tests run, and paper orders and
  fills recorded since. Paper orders at Alpaca survive at Alpaca; reconciliation reports the
  difference as incidents rather than inventing history.
- **Recovery time objective (RTO): 4 hours** from the moment the operator sees the alert, during
  the operator's waking hours. The measured restore itself must take well under that; the rest is
  noticing, deciding, and checking. There is no on-call outside waking hours, so an overnight
  outage can last until morning; running strategies are paper only.

These are checked by the restore drill below, not assumed.

## Restore drill

Run in staging before launch and after any change to backups. Restore the newest **scheduled**
R2 backup (not a manual export) into a new, empty Postgres service, point a copy of web at it,
and sign in.

1. In staging, create a second Postgres service `Postgres-restore`.
2. From a machine with the AWS CLI, `psql` and `pg_restore` (or the backup image), with the
   staging R2 read token: start a timer, then follow "Restoring for real" in
   `docs/runbooks/backups.md` against `Postgres-restore`, using
   `aws s3 cp s3://<bucket>/staging/<newest dump> .`.
3. Point staging web's database variables at `Postgres-restore`, redeploy web, sign in with a
   staging account, and open a strategy and the Orders tab. Stop the timer.
4. Point web back at `Postgres` and delete `Postgres-restore`.
5. Record the drill below.

| Date       | Environment                           | Backup used (time)                                            | Restore took                | Signed in?                 | Met RPO / RTO?   | What failed or surprised                                                                 |
| ---------- | ------------------------------------- | ------------------------------------------------------------- | --------------------------- | -------------------------- | ---------------- | ---------------------------------------------------------------------------------------- |
| 2026-11-05 | Rehearsal in a container, not staging | `backup.sh` to an S3 stand-in, then `restore-check.sh latest` | under 2 s for a 0.3 MB dump | Not tried (no app started) | Not a real drill | Both scripts ran unchanged against an S3-compatible endpoint. Real timings need staging. |
| _pending_  | staging                               |                                                               |                             |                            |                  | Needs Railway, R2 and the uptime monitor set up                                          |

## Later

- **Alpaca paper keys.** Saving a provider key needs the credential key set up in
  [Credential key (AWS KMS)](#credential-key-aws-kms). Paper keys only.
- **Stripe (test mode).** Paid plans need a Stripe account (`docs/adr/0023-billing-with-stripe.md`).
  Only test-mode keys are accepted; the app refuses to start with a live one.
  1. In Stripe's test mode, create a product "Pro" with a monthly price, and copy the price id
     (`price_…`).
  2. Point the Pro plan at it. In Railway's Postgres service, open the Data tab's query editor
     and run `update plan set stripe_price_id = 'price_…' where code = 'pro';`.
  3. Developers → Webhooks → Add endpoint: `https://<web domain>/api/v1/webhooks/billing`, with
     the events `checkout.session.completed`, `customer.subscription.created`,
     `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid` and
     `invoice.payment_failed`. Copy its signing secret (`whsec_…`).
  4. Settings → Billing → Customer portal: turn it on, allowing cancelling and card updates.
  5. Add to web: `STRIPE_SECRET_KEY=sk_test_…` and `STRIPE_WEBHOOK_SECRET=whsec_…`. Add to worker:
     `STRIPE_SECRET_KEY=sk_test_…` (it re-reads subscriptions hourly in case a webhook is missed).
- **Plans.** Prices and limits live in the `plan` table (`docs/adr/0022-plans-and-limits.md`).
  Change them with an `update plan …` in the same query editor; they apply at once.
- **More invites.** Mint one code per person, up to the 20 Yong settled on: `invites:mint 5
"second round"`.
- **Your own domain.** Add it under the web service's Networking, then change `APP_URL`.
- **VIX sources.** The worker reads the VIX from Cboe's free history CDN and, when that fails,
  from FRED's VIXCLS closes. Both are optional worker variables, for a mirror or a moved URL:
  `CBOE_HISTORY_URL` (default `https://cdn.cboe.com/api/global/us_indices/daily_prices`) and
  `FRED_CSV_URL` (default `https://fred.stlouisfed.org/graph/fredgraph.csv`); both must be https.
  The data is Cboe's either way, and its display terms have not been reviewed for a paid service
  (ADR 0042, `CBOE_DISPLAY_TERMS`); the launch gate lists it.
- **Owner connection.** `DATABASE_URL` stays on the web service only because Railway runs the
  pre-deploy step with that service's variables. The running app never connects with it.

## Leftover demo instruments

`pnpm --filter @tm/db demo:check` (owner connection) lists any demo instruments still in the
database and whose strategies, orders or positions use them. `demo:remove-unused` deletes the
ones nothing uses any more (ADR 0046).
