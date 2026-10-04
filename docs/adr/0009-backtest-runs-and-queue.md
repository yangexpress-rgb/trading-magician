# ADR 0009: Back-test runs and job queue

- **Status:** accepted
- **Date:** 2026-10-04
- **Design refs:** §7.2, §13.3, §14.2, §16.2, §17.2

## Context

Back tests run asynchronously, report queued, running, completed, failed or canceled, and record
the exact strategy version, data version, engine version and assumptions (§7.2). They must not
block interactive traffic (§17.2) and must keep tenants apart like every other table (ADR 0003).

## Decision

- **Tables.** `backtest_run` holds inputs, status, provenance, the metrics summary and the result
  (equity, contributions, fills, warnings, assumptions) as JSON. `backtest_trade` holds one row per
  cycle with its legs. Both use the tenant policy from ADR 0003; the app can't delete runs.
- **Pinned version.** Queuing a run pins the draft to an immutable `strategy_version`: the current
  one, an earlier one with the same rules, or a new snapshot. Only the version pointer moves, so an
  editor open elsewhere keeps its `rowVersion`.
- **Queue in Postgres.** No extra infrastructure. `claim_backtest_run(worker, lease, attempts)` is a
  `SECURITY DEFINER` function that picks the oldest runnable run with `FOR UPDATE SKIP LOCKED`, sets a
  lease, and returns only the run and tenant ids. A policy scoped to the migration owner lets the
  function see every tenant's runs; `tm_app` cannot assume that role. Everything else the worker
  does runs in `withTenant` and is guarded by `lease_owner`, so a worker that lost its lease can't
  write.
- **Leases.** The worker renews its lease between steps. If a worker dies, its lease lapses and the
  next claim hands the run to another worker, up to a maximum number of attempts, after which the
  run fails. Deterministic errors fail the run at once with a message safe to show the user.
- **Cancel.** A queued run cancels at once. A running run is flagged; the worker stops at its next
  checkpoint, and a lapsed lease on a flagged run ends it as canceled.
- **Limits.** Per user, from the plan's entitlements: concurrent runs (default 2) and runs per day
  (default 100), checked under an advisory lock so parallel requests can't race past them.
- **Data source.** Generated demo history (§20 #1, proposed) until a provider is chosen.

## Consequences

- The simulation is synchronous; a very long run holds its lease until the next checkpoint, so the
  lease (120 s by default) must exceed the longest run. Runs are capped at 5 years daily or 1 year
  hourly, which takes a few seconds.
- Changing the owner of `backtest_run` requires recreating the `queue_owner` policy.
