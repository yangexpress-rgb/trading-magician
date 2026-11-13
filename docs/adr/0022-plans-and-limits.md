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
- **Platform admins skip the saved-strategy cap (amended 2026-11-12, design v1.2 N249).** The person
  testing and reviewing the product should not have to delete strategies, or hold a paid-tier
  workaround, to make a new one. `assertWithinLimit` skips `savedStrategies` when the caller is a
  platform admin (`is_platform_admin()`, ADR 0037: the one admin role, granted only by
  `users:grant-admin`; never an email address). The exemption is a fixed set, `ADMIN_EXEMPT`, holding
  that one limit (N251 below adds active strategies): back tests, accounts and the feature gates still apply to admins
  as to anyone on their plan, and plans, entitlements and billing are unchanged. An admin's usage can
  read above the plan's allowance on Settings › Subscription and billing.
- **Platform admins skip the running-strategy cap too (amended 2026-11-13, design v1.2 N251).**
  `ADMIN_EXEMPT` also holds `activeStrategies`: Start and Resume (`assertCanResume`) don't count an
  admin's running strategies. The paper risk limits are not plan limits and still apply. A plan change
  still pauses an admin's strategies over the new plan's limit (billing is unchanged, and the worker
  role cannot read `is_platform_admin()`); the admin can resume them.
- **Lowering a limit never deletes anything.** Over-limit strategies and accounts stay; only new ones
  are refused. What a downgrade does to running strategies is ADR 0023's subject.
- **Tests.** New workspaces can start on another plan through `SIGNUP_PLAN` (web), which end-to-end
  tests set to `dev`; integration tests make `dev` the default except in `entitlements.test.ts`.
  Production leaves it unset.

## Consequences

- Changing prices or limits is a database update, recorded in the migration history only when made
  through a migration; the owner should make such changes through one.
- Stripe prices (M6.2) attach to these plans, so the catalog stays the single source of limits.
