# ADR 0026: Controlled launch

- **Status:** accepted
- **Date:** 2026-10-05
- **Design refs:** §16.1, §16.4, §19, §20 #14

## Context

§16.4 asks for a controlled multi-user launch with a risk notice and basic legal pages, and §16.1
for a security review with dependency and container scanning and rate limits on the paths that
cost most. Yong decided on 2026-10-05: invite-only, up to 20 people, using invite codes. The app
stays paper-only, and Stripe stays in test mode.

## Decision

- **Invite codes.** `invite` holds a SHA-256 hash of each code, an optional note, an optional
  expiry, and who claimed it. Codes read as four groups of four from an alphabet without
  look-alike characters, and are accepted in any case with or without separators. They are minted
  with `pnpm --filter @tm/db invites:mint <count> [note]`, which prints them once; only the hashes
  are kept, so a lost code is replaced rather than recovered. `invites:list` shows how the launch
  is going without ever showing a code, and `invites:release` frees an unused one. The cap of 20 is
  the number of codes minted.
- **Where the check happens.** `POST /api/auth/sign-up/email` goes through a gate in front of
  Better Auth's handler: it claims the code atomically (`claim_invite`, `FOR UPDATE SKIP LOCKED`)
  before the account is created, so one code admits one person even under two simultaneous
  sign-ups; names who used it once the account exists, audited as `account.invited`; and gives the
  code back if the sign-up did not go through. A database hook was tried first and rejected: the
  adapter does not let a hook refuse the request.
- **Switching it off.** `SIGNUP_MODE` is `invite` by default and `open` for development, tests and
  load testing. The sign-up form shows the code field only when a code is needed.
- **Risk notice and legal pages.** The §16.4 notice ("paper trading only, simulated orders,
  not financial advice") appears on sign-up, in the app's footer on every signed-in page, and at
  the top of the terms. `/terms` and `/privacy` are public, say plainly that they are placeholders
  that no lawyer has reviewed, and describe what the app actually stores. They are replaced before
  anyone is charged or live trading is possible.
- **Tighter rate limits.** On top of 120 changes a minute per person (ADR 0025), back-test starts
  are capped at 20 a minute and the order-placing paths (start, stop, execution, order cancels) at
  30 a minute, in one table in `apps/web/lib/server/api.ts`.
- **Scanning in CI.** A `scan` job runs Gitleaks over the repository and its history, and Trivy
  over the built runtime image and the deploy files, failing on HIGH or CRITICAL with a fix
  available. `pnpm audit --prod` already gates shipped dependencies.
- **Security review.** `docs/security-review.md` records what protects each boundary, where to
  check it, which risks are accepted for the invite-only test, and what must change before a
  wider launch.
- **Load test.** `load/` holds a k6 script and a seed script for 20 accounts with 5 strategies
  each and 10 back tests at once, with thresholds for the p95 page target, plus `load/orders.sql`
  for the order-within-5-seconds target. It is run by hand against staging; k6 is not in CI.

## Consequences

- Nobody can sign up in production without a code, including Yong: mint one first.
- The invite-only sign-up is tested against a second web server in the end-to-end run, so the
  suite starts two web servers.
- A code is spent when an account is created, even if the person never verifies their email;
  `invites:list` shows it as claimed and `invites:release` is how to give it back.
