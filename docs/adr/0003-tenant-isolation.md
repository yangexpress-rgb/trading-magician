# ADR 0003: Tenant isolation with database roles and row-level security

- **Status:** accepted
- **Date:** 2026-10-04
- **Design refs:** §4.1, §13, §16.1, §16.2, §19.1

## Context

No user may read or change another user's records, and the design asks for this to be enforced in both application authorization and database policy.

## Decision

**Three database roles.**

| Role      | Used by                           | Can touch                                                                     |
| --------- | --------------------------------- | ----------------------------------------------------------------------------- |
| owner     | migrations and seeding only       | everything (subject to the audit trigger)                                     |
| `tm_app`  | web and worker at runtime         | tenant tables through RLS; reference data read-only; own `user` row read-only |
| `tm_auth` | the authentication library (M0.3) | auth tables only; no tenant data                                              |

`tm_app` and `tm_auth` are `NOLOGIN` group roles created by migration `0001_security`. Login users are granted membership by infrastructure (locally: `pnpm --filter @tm/db db:setup-logins`).

**Row-level security.** Every tenant table has `ENABLE` and `FORCE ROW LEVEL SECURITY` and a policy comparing `user_id` with `app_current_user_id()`, which reads the transaction-local setting `app.user_id`. With no setting, the function returns NULL and no rows match. The application sets it only through `withTenant(db, { userId }, fn)`, whose `userId` comes from the server-side session.

**Same-tenant references.** Parent tables expose a `UNIQUE (id, user_id)` key, and children reference it with composite foreign keys, so a row cannot point at another tenant's feed, broker or account even if application code passes a foreign id.

**Append-only audit.** `tm_app` has only `SELECT` and `INSERT` on `audit_event`, and a trigger rejects `UPDATE`, `DELETE` and `TRUNCATE` from every role. `audit_event.user_id` has no foreign key, so the trail survives account deletion; it stores identifiers only. The retention period is open product decision §20 #14.

**Entitlements.** `tm_app` may insert its own entitlement during provisioning but never update it. Billing webhooks will write entitlements through a separate system path in Phase 6.

## Consequences

- Every query against tenant data must run inside `withTenant`; outside it the app role sees nothing, which fails safe.
- Integration tests run as the real `tm_app`/`tm_auth` login roles against a fresh database (`packages/db/test`), never as a superuser, because superusers bypass RLS.
- Managed Postgres providers must allow the owner to create roles, or the roles are created by infrastructure before migrating.
