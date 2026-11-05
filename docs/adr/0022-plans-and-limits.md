# ADR 0022: Plans and limits

- **Status:** accepted
- **Date:** 2026-10-05
- **Design refs:** §4.3, §13.1, §19.8, §20 #4

## Context

§4.3 asks for plan limits that are configurable rather than hard-coded and enforced on the server
(§19.8). Until now every workspace got a copy of a placeholder "dev" plan's limits, and only the back
test limits were checked. Yong approved the Phase 6 defaults on 2026-10-05: a Free and a Pro plan,
with prices and limits as placeholders he can change.

## Decision

- **A plan catalog in the database.** The `plan` table holds each plan's name, price (in cents),
  billing interval and limits. The app can read it but not change it; the owner changes a limit by
  updating a row, and it applies at once. `offered` plans are listed to users; one plan is the default
  for new workspaces. The internal `dev` plan is not offered; workspaces created before Phase 6 stay
  on it.
- **Entitlement = plan + overrides.** Each workspace's `entitlement` row names its plan and holds
  per-user `overrides` (usually empty). Limits are resolved when read
  (`resolveLimits` in `@tm/domain`); anything missing or malformed falls back to the most restrictive
  value, never to unlimited.
- **What is limited.** Saved strategies (not deleted), active strategies, back tests per day and at a
  time, active trading accounts, connecting a broker other than the demo one (`paperIntegrations`),
  and adding a market-data provider (`liveData`). `realIntegrations` exists in the vocabulary only: a
  CHECK on `plan` keeps it false until Phase 7 (ADR 0002).
- **Where it is enforced.** In `packages/db/src/entitlements.ts`, inside the same transaction as the
  change, after a per-user advisory lock so two requests can't both pass a limit. The API answers
  `403 plan_limit` with the limit, plan, allowance and current use in `details`. An account the
  worker discovers past the limit is added but left off, and turning it on is refused.
- **Lowering a limit never deletes anything.** Over-limit strategies and accounts stay; only new ones
  are refused. What a downgrade does to running strategies is ADR 0023's subject.
- **Tests.** New workspaces can start on another plan through `SIGNUP_PLAN` (web), which end-to-end
  tests set to `dev`; integration tests make `dev` the default except in `entitlements.test.ts`.
  Production leaves it unset.

## Consequences

- Changing prices or limits is a database update, recorded in the migration history only when made
  through a migration; the owner should make such changes through one.
- Stripe prices (M6.2) attach to these plans, so the catalog stays the single source of limits.
