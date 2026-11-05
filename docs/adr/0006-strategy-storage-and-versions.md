# ADR 0006: Strategy storage, versions and API

- **Status:** accepted
- **Date:** 2026-10-04
- **Design refs:** §6.1–6.3, §6.10, §13.2, §14.1, §19.1, §19.2

## Context

A strategy is edited freely while it is a draft. Once it has run, its orders must keep pointing at the exact rules that produced them. Saving and reloading a strategy, and evaluating it, must give identical results.

## Decision

**One JSON document per definition.** The definition (conditions, planned orders, timing, execution policy, risk) is the `StrategyDefinition` from `@tm/domain` (schema v1), stored as `jsonb`. It is not split into relational tables, so a version is a single atomic snapshot and every save is validated by one schema. Older `schemaVersion`s are migrated on read; stored versions are never rewritten. Fields the library filters on are projected into `strategy` and the `strategy_instrument` index, which is rebuilt on every save.

**Draft and versions.**

- `strategy.draft_definition` is the mutable working copy, with `draft_hash` (sha256 of canonical JSON).
- `strategy_version` rows are immutable. `tm_app` can only `SELECT` and `INSERT` them, and a trigger rejects `UPDATE`, `DELETE` and `TRUNCATE` from every role. The one exception is the foreign-key cascade when the owning account is deleted, which the trigger detects with `pg_trigger_depth()`.
- Starting a strategy snapshots the draft as a new version unless it equals the current version by hash.
- After a strategy has run once, any change to its rules publishes a new version immediately.
- Rules can't change while the strategy is actively executing. Name, description and tags can.

**Soft delete.** `tm_app` has no `DELETE` on `strategy`. Deleting sets `deleted_at`, and a deleted strategy behaves as not found everywhere. Versions and status history stay linked for later order history.

**Lifecycle.**

- `strategy_status_change` records every transition, the version that was pinned, and the warnings the user acknowledged.
- Activation goes through `planTransition` from `@tm/domain`. It requires no validation errors, every warning acknowledged, and explicit confirmation.
- The start request must say `mode: "paper"`.

**Optimistic concurrency.** Every mutating call carries the `rowVersion` the client last saw. A stale value returns `409 conflict` instead of overwriting.

**API.**

- REST route handlers under `/api/v1/strategies`, matching §14.1. They add `GET /strategies/{id}/versions/{n}` for the version history view.
- Request shapes live in `@tm/contracts` and are validated on the server. Errors use one body: `{ error: { code, message, issues?, details? } }`.
- Mutating requests must carry the app's own `Origin`, which adds CSRF defence on top of SameSite cookies. They are also rate limited per user, in memory, because Phase 1 runs a single web instance.
- The tenant comes only from the server-side session. Another tenant's strategy is indistinguishable from a missing one (404).

## Consequences

- Querying inside definitions (for example "all strategies using RSI") needs either a projection or `jsonb` operators. Only instruments are projected for now.
- The in-memory rate limiter must move to a shared store before the web app runs on more than one instance.
