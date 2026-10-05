# Deploying to Railway

The app runs as three Railway services in one project: **Postgres**, **web** (Next.js) and
**worker** (back tests, paper runtimes, feed and broker checks, valuations). Web and worker
build from the same `Dockerfile`; their start commands live in `deploy/railway/web.json` and
`deploy/railway/worker.json`.

Every web deploy first runs migrations, the demo seed and `db:setup-logins` (the
`preDeployCommand`). All three are safe to repeat.

Paper trading only, as everywhere else (`docs/adr/0002-paper-only-guard.md`).

## What you need

- A Railway account on the Hobby plan, with GitHub connected so it can see this repository.
- A Resend account for sign-up and password-reset emails, and one API key from it. Until you
  verify a domain with Resend, it only delivers to the address you signed up to Resend with,
  so that is the only address that can finish signing up.
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
   - Config-as-code: set the path to `/deploy/railway/web.json`.
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
   ```

4. **Worker service.** New → GitHub Repo → the same repository, same branch. Name it
   `worker`. Config-as-code path: `/deploy/railway/worker.json`. No domain. Variables:

   ```text
   DATABASE_WORKER_URL=postgresql://tm_worker_login:${{shared.DB_WORKER_LOGIN_PASSWORD}}@${{Postgres.PGHOST}}:${{Postgres.PGPORT}}/${{Postgres.PGDATABASE}}
   ```

   The worker restarts until the web service's first deploy has created its database login.

5. **Deploy and sign up.** Deploy both services, open the web domain, and sign up with your
   Resend address. The verification email arrives from `onboarding@resend.dev`.

## Staging and production

Railway environments keep two full copies apart (ADR 0025). Once production works:

1. Project Settings → Environments → New Environment → **Duplicate** `production`, name it
   `staging`. Railway copies the services and variable names; it gives staging its own Postgres.
2. In staging, set every random string and key again with **new** values (shared variables,
   `BETTER_AUTH_SECRET`, Stripe webhook secret for a second endpoint pointing at staging's
   domain). Never share a secret between the two.
3. Point staging's web and worker at the branch you want to try; keep production on `main`
   once the stack is merged.
4. Optional for staging only: `SIGNUP_PLAN=pro` on web, so test sign-ups skip checkout.

## Monitoring

- **Error reports (Sentry).** Create a free Sentry account and a Node project, copy its DSN
  (Settings → Client Keys), and add `SENTRY_DSN=<dsn>` to web and worker in each environment.
  Reports are tagged with the Railway environment and commit.
- **Uptime check.** In an uptime service such as Better Stack or UptimeRobot (free tiers are
  enough), add an HTTP monitor for `https://<web domain>/api/health/system` every minute,
  alerting by email when it is not 200 for 2 checks in a row. It turns red when the database
  or the worker is down.
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

## Later

- **Alpaca paper keys.** Saving a provider key needs the credential key pair
  (`docs/adr/0015-credential-storage.md`). Run `pnpm --filter @tm/db credentials:keygen`
  locally, then add `CREDENTIALS_PUBLIC_KEY` to web and `CREDENTIALS_PRIVATE_KEY` to worker.
  Never give the private key to web; it refuses to start with it.
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
- **Your own domain.** Add it under the web service's Networking, then change `APP_URL`.
- **Owner connection.** `DATABASE_URL` stays on the web service only because Railway runs the
  pre-deploy step with that service's variables. The running app never connects with it.
