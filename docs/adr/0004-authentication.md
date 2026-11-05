# ADR 0004: Self-hosted authentication with Better Auth

- **Status:** accepted (confirmed by Yong, 2026-10-04)
- **Date:** 2026-10-04
- **Design refs:** §4.2, §16.1, §19.1

## Context

Phase 0 needs sign-up with email verification, sign-in/out, credential reset, session management and account deletion, with user data kept inside the tenant boundary.

## Decision

Use Better Auth, self-hosted, with its Drizzle adapter on our Postgres.

- **Isolation.** Better Auth connects as `tm_auth`, which can reach only `user`, `session`, `account`, `verification` and `rate_limit`. The app role cannot read sessions, password hashes or tokens (ADR 0003).
- **Identifiers.** User ids are UUIDs (`advanced.database.generateId: 'uuid'`), matching every other table.
- **Email and password.** Minimum 12 characters; email verification is required before a session is issued; verification is re-sent on sign-in attempts; resetting a password revokes all sessions.
- **Sessions.** Seven-day sessions refreshed daily; users can list sessions and sign out one or all other devices.
- **Account deletion.** Requires the password and a typed confirmation. An `account.deleted` audit event is written first; deleting the user cascades to all tenant data. The audit trail is retained (retention policy is §20 #14).
- **Rate limiting.** Always on, stored in Postgres so it holds across instances: 10/min for sign-in, 5/min for sign-up, 3/min for reset and verification emails, 100/min otherwise.
- **CSRF.** Better Auth checks `Origin` against `APP_URL`; Next.js server actions check `Origin` against `Host`. Cookies are `httpOnly`, `SameSite=Lax`, and `Secure` when `APP_URL` is https.
- **Workspace provisioning** happens on the first authenticated request (`requireTenant`), not in an auth hook, so it never depends on the auth library's transaction having committed. It is idempotent.
- **Email delivery** goes through a `Mailer` interface: SMTP (Mailpit locally) or a JSON outbox for development and end-to-end tests. The outbox refuses to run in production unless `E2E_TEST` is set.

## Consequences

- Client IPs for rate limiting come from a single-value `X-Forwarded-For` by default. Behind a proxy that appends to that header, Better Auth cannot tell clients apart and every visitor would share one bucket, so a hosted deployment sets `AUTH_IP_HEADERS` (a header the proxy sets to the client address, for example `x-real-ip`) or `AUTH_TRUSTED_PROXIES` (the proxies' IPs or CIDR ranges, so the forwarded chain is walked past them). Both feed `advanced.ipAddress` (`apps/web/lib/client-ip.ts`, added 2026-11-05 for design v1.1 deviation D5). Running locally needs neither.
- Social sign-in can be added later as Better Auth providers without schema changes.
- If the auth library is ever replaced, only `apps/web/lib/server/auth.ts`, the auth tables and the auth pages change.
