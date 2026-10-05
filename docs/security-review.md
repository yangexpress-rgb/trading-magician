# Security review

Design v1.0 §16.1, done before the invite-only launch (ADR 0026). It walks the app from the
outside in and records what holds today, with where to check it. Everything here is about an app
that trades on paper only: the paper-only guard (ADR 0002) and the database CHECKs that enforce
it are themselves part of the review.

Reviewed 5 October 2026 against the Phase 6 stack (PRs #31 to #35).

## Boundaries

| Boundary                | What protects it                                                                                                                                | Where                                                                 |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Browser to the app      | HTTPS from the host, a nonce Content-Security-Policy, `X-Frame-Options: DENY`, `nosniff`, a referrer policy and a permissions policy            | `apps/web/proxy.ts`, `apps/web/next.config.ts`, e2e `shell.spec.ts`   |
| Sign-in                 | Better Auth with scrypt password hashing, 12-character minimum, email verification, sessions revoked on password reset, per-route limits        | `apps/web/lib/server/auth.ts`, e2e `auth.spec.ts`                     |
| Any changing request    | Session required, same-origin check, 120 changes a minute per person, 20 back tests and 30 execution calls a minute                             | `apps/web/lib/server/api.ts`, e2e `ops.spec.ts`, `strategies.spec.ts` |
| One tenant from another | Row-level security on every tenant table as `tm_app`, with the tenant from the session only; cross-tenant work only through audited functions   | `packages/db/src/tenant.ts`, db `security.test.ts`                    |
| Secrets in the database | Provider keys sealed to a key pair the web app cannot open; only `tm_secrets` reads the sealed columns                                          | ADR 0015, db `credentials.test.ts`                                    |
| Billing                 | Webhook HMAC with a 5-minute tolerance, event ids stored once, the subscription read back from Stripe, writes only through `apply_subscription` | ADR 0023, db `billing.test.ts`                                        |
| Real money              | No live broker host or live key is accepted, and `CHECK` constraints refuse live accounts and connections                                       | ADR 0002, db `security.test.ts`                                       |
| Who may sign up         | Invite codes stored as hashes and claimed atomically; one code admits one person                                                                | ADR 0026, db `invites.test.ts`, e2e `invite.spec.ts`                  |

## What is checked automatically

- Every pull request runs lint, typecheck, unit tests, 134 database and 34 worker integration
  tests, and the end-to-end suite, which includes accessibility and CSP checks.
- `pnpm audit --prod --audit-level=high` fails the build on a known vulnerability in what ships.
- Gitleaks scans the repository and its history for secrets; Trivy scans the runtime image and
  the deploy files. Both fail the build (`.github/workflows/ci.yml`).
- Dependabot opens dependency updates.

## Risks accepted for the invite-only launch

| Risk                                                         | Why it is acceptable now                                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| No second factor on sign-in                                  | Up to 20 invited people, paper trading only, no payment instrument stored in the app.            |
| Terms and Privacy are placeholders, not reviewed by a lawyer | Stated plainly on both pages; they are replaced before charging anyone or allowing live trading. |
| Stripe stays in test mode, so no real payment is taken       | Yong's decision; going live needs a reviewed change to the key check and legal review (§16.4).   |
| Browser-side errors are not reported                         | Server errors are, and the people testing can say what they saw.                                 |
| The owner's database connection can read everything          | It is used only by migrations, seeding and the backup job, and never by the running app.         |
| Email delivery is limited to verified Resend addresses       | It also keeps strangers from finishing sign-up during the invite-only test.                      |

## Still to do before a wider launch

- Replace the placeholder Terms and Privacy with reviewed ones, and add a record of each
  person's acceptance.
- Add a second factor, and consider sign-in alerts.
- Report browser errors, and watch the uptime check with paging rather than email.
- Re-run this review when live trading is on the table; the paper-only guard is what most of
  the safety rests on.
