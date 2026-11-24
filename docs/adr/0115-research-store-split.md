# ADR 0115: A Research Store of its own, retention trims, and a storage alert per volume

- **Status:** accepted
- **Date:** 2026-11-24
- **Design refs:** design v1.3 §17.4, §20.2, §20.3; N331 to N333; O212 to O215. Yong's brief
  "Separate the research data from the trading core, with a built-in local setup flow"
  (2026-11-24), stage S1. Follows the 2026-11-23 outage when the one database's volume filled.

## Context

On 2026-11-23 staging's only Postgres volume filled and trading stopped with it. Measured on
2026-11-24 (S0, real `pg_total_relation_size` output): the database was 3,995 MB, of which
`factor_snapshot` was 3,034 MB, `option_chain_snapshot` 485 MB, `fundamental_observation` 161 MB,
`pattern_occurrence` 94 MB, `option_contract` 65 MB and `ml_feature_snapshot` 42 MB. Almost all of
it is research data that no running strategy, order or the Orders page reads.

## Decision

- **Two stores.** The Core Store is the existing database. The Research Store is a second
  Postgres database (its own Railway service and volume) holding `option_contract`,
  `option_chain_snapshot`, `factor_snapshot`, `factor_coverage`, `pattern_scan`, `pattern`,
  `pattern_occurrence`, `ml_feature_snapshot`, `ml_label`, `ml_evaluation`, `ml_report`,
  `ml_frozen_as_of` and `backtest_trade` (`RESEARCH_TABLES` in `packages/db/src/research.ts`). It
  has its own migrations (`packages/db/research-migrations`), the same roles and row-level
  security. Everything else stays in Core.
- **Configuration only.** Every research read and write goes through a `ResearchStore`
  (`researchStore(core, research?)`) or a tenant-scoped `ResearchTx`. With no `RESEARCH_*` URLs the
  same tables in Core answer, so tests, local runs and the switch-over need no code change:
  `RESEARCH_DATABASE_URL` (owner: migrations and logins), `RESEARCH_DATABASE_APP_URL` (web) and
  `RESEARCH_DATABASE_WORKER_URL` (worker, ml-trainer).
- **No foreign keys across the stores.** `backtest_trade → backtest_run`, `ml_evaluation →
ml_model_run` and the user foreign keys are dropped on the Research side. A daily sweep
  (`sweepResearchStore`) deletes Research rows whose user or back test run no longer exists in
  Core. The trigger that refused feature snapshots for dates a frozen prediction exists for now
  reads `ml_frozen_as_of`, which an `ml_prediction` insert in Core (trigger) or the trainer
  (`freeze_date`) fills.
- **Back test trades in Research, summary in Core.** A run's trades are written to Research
  before the run's Core row is marked done; the run summary, its figures and cycles stay in Core,
  so a run page loads without Research. If Research cannot be reached the run ends `failed` with
  "Research storage is not reachable right now: research results are paused. Trading is
  unaffected." (`ResearchUnavailableError`). Research pages show the same sentence.
- **Trading never names Research.** The paper runtime, the order flow and the Orders page's reads
  name no research table and no research connection; a test enforces it
  (`apps/worker/test/research-separation.test.ts`).
- **The move.** `pnpm --filter @tm/db research:move` copies each research table from Core to
  Research in 64 MB page slices with `COPY`, inserting with `ON CONFLICT DO NOTHING`; it never
  deletes and can be repeated. A move verifies when a repeat copies nothing, leaves nothing out and
  Research holds at least Core's count for every table. `research:clear-core` empties Core's
  copies (`TRUNCATE`) only after such a verifying pass, and only when Yong says so.
- **Retention (N332).** Once a New York day the worker deletes notifications older than 180 days,
  audit events older than 365 days (the database refuses fewer, and the audit table stays
  append-only for everything else), raw option chains older than 90 days (daily and expiry
  signals kept), and thins position snapshots to the last one per account, instrument, source and
  day once older than 30 days.
- **Storage alert per volume (N333).** Every 15 minutes the worker measures each database against
  its own volume (`CORE_VOLUME_MB`, `RESEARCH_VOLUME_MB`); at 80% it logs and notifies the admin
  once a day per store (`storage_alert`). A Research outage never stops the Core check.

## Deviations from the brief

- **Small reference data stays whole in Core (O212, Yong 2026-11-24).** The Window Contract keeps
  fundamentals, earnings, deals, rates, short interest, options signals and ML predictions whole in
  Core, because conditions and back tests read their full history and windowing them would change
  readings. About 0.2 GB. `WINDOW_CONTRACT` records it.
- **No bar windows to enforce.** There is no stored price-bar table (bars come live from the price
  feed), so the 13-month and 35-day bar windows have nothing to apply to yet.
- **The Window Contract job is a boundary check.** With nothing else to move by age, the daily job
  warns while research tables still hold rows in Core, instead of moving rows by date.
- **`pattern` moves with its occurrences (O213).** The brief lists pattern mining results as
  research data; `pattern_occurrence` belongs to `pattern`, so both live in Research. A strategy's
  link to a promoted pattern is unchanged.
- **Retention periods chosen here (O214).** The brief named hard expiry without periods:
  notifications 180 days, audit events 365 days, intraday position snapshots 30 days. Account and
  book valuations are already one per session, so only position snapshots are thinned.
- **Volume sizes are configuration (O215).** Railway does not report a volume's size to the
  service, so the alert reads it from `CORE_VOLUME_MB` and `RESEARCH_VOLUME_MB` (10,000 MB by
  default); growing a volume means updating its variable too.

## Consequences

A full Research volume stops research jobs, not trading. The move runs once before the services
switch to Research and once after: trades a run stored in Core between the two passes are missing
from its page until the second pass copies them. Deleting a user removes their Research rows at the
next daily sweep rather than at once.
