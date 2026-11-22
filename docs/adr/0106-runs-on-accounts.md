# ADR 0106: A run is one strategy on one account; a strategy can run on several accounts at once

- **Status:** accepted
- **Date:** 2026-11-22
- **Design refs:** design v1.3 §12.1, §12.5, §12.7, §13; N308, N309, N310; O177 to O180.
  Phase 7 brief ("many accounts (paper + real), one strategy, trades kept separate", Yong via
  Muse, 2026-11-22), build P0. Amends ADR 0018 (routing per account) and ADR 0024 (what the
  plan's running-strategies limit counts).

## Context

Yong's bottom line for Phase 7: strategies are built once and shared without re-building, paper
and real accounts co-exist, and trades are kept separate. Until now a strategy's legs each named
the account they traded on, and a strategy had at most one active runtime
(`strategy_runtime_one_active_idx` on `strategy_id`). Every strategy in the Lab points at the one
Alpaca paper account. Orders, fills, book valuations and account valuations already carry their
account, but nothing tied a run to one account, and nothing stopped a run from sending an order
to an account other than the one it was started for.

Strategies that share an Alpaca account net at the broker (ADR 0105), so each account is its own
netting and risk universe. This build (P0) adds the account to the run and keeps everything
separate by account. The account risk layer (P1), per-account feeds (P2) and the live gate (P3)
follow, each after Yong's review. Nothing here makes live trading possible: accounts are still
paper only in the database (`trading_account_paper_only`, ADR 0002).

## Decision

- **N308: a run is one strategy on one account.** `strategy_runtime.account_id` (migration 0103)
  names the account every order of the run goes to, whatever account the strategy's legs name.
  The worker reads the run's pinned version through `bindDefinitionToAccount`, which puts every
  leg (entry groups included) on the run's account; the stored definition never changes. A
  strategy has at most one active run per account (`strategy_runtime_one_active_idx` is now on
  `strategy_id, account_id`), so the same strategy can run on several accounts at once, each run
  independent: pausing, resuming or stopping one never touches another. A run's account never
  changes (trigger `strategy_runtime_account_fixed`).
- **Starting asks one question: which account?** The Start dialog lists the accounts the strategy
  has no run on, paper accounts first and live ones in their own group (none can exist yet), and
  defaults to the account the legs name. Validation runs on the rules as that account would trade
  them (its capabilities and coverage). A strategy that is already actively executing gets
  **Start on another account**: the same checks and confirmation, a new run pinned to the same
  version, no new status change. Each run has its own **Stop this run**; stopping the last run
  turns the strategy Off as before.
- **Migration.** Every existing run is bound to the account its pinned version's first Entry leg
  names (else its first Exit leg, else the account of its latest order, else the person's default
  account), only ever an account of the same person. Its orders, fills, positions, cycles and
  performance stay attached to it. Stopped runs that never had any account stay without one
  (`strategy_runtime_account` allows that only for stopped runs). No strategy definition, version
  or risk limit is changed.
- **N310: an order only ever goes to its own run's account (A6).** Three checks, each before the
  broker adapter: `recordOrderIntent` refuses an intent whose account is not its run's
  (`account_mismatch`); the database refuses it too (trigger `order_intent_run_account` on insert
  and on any change of an intent's run or account); and the worker's `submit` refuses, fails and
  audits (`order.account_refused`) any ready order whose account differs from the run's, without
  calling the adapter. Orders recorded before migration 0103 are not re-checked.
- **N309: every view says which account.** Orders gets an account switcher (All accounts, then
  each account labelled with its name and PAPER or LIVE, in words), which narrows the orders,
  Strategies on paper and positions; the address keeps it (`?account=`). Every run, order and
  position row shows its account with the same label, and the paused banner names the account.
  Performance's account filter uses the same labels, and Contribution by strategy has one row per
  strategy **and account** ("this strategy, on this account"), so a strategy on two accounts is
  never one blended row. Account equity, P/L and win rate were already per account (ADR 0020,
  0021).
- **What reads one account at a time.** Reconciliation, broker sync and the account valuation
  already worked per account; a run now syncs its own account (and any account an older order of
  it went to). Strategy exposure and the daily loss limit stay per run. The account-level limits
  (D4) are P1.
- **Plan limits (ADR 0024 amended).** The plan counts strategies running, not runs: another run of
  a strategy that already runs adds nothing, and a plan change pauses the runs of the strategies
  beyond the limit.

## Consequences

- The same strategy can trade on two paper accounts at once with its orders, positions and
  results apart (A1); covered by `apps/worker/test/runtime.test.ts` ("one strategy on two
  accounts") and `packages/db/test/strategies.test.ts`.
- Rules still can't change while a strategy runs, so every run of a strategy is on the same
  version. Moving a run to a newer version ("This run is using the version from Nov 20: switch to
  the latest?") needs editing while running, which is not built (O177).
- A strategy whose legs named more than one account now trades every leg on its run's account.
  None is known on staging (every Lab strategy names the one Alpaca paper account) (O179).
- `LIVE_TRADING_ENABLED` stays the compile-time constant of ADR 0002 and every mode column stays
  paper only; the live gate (P3) replaces that guard with the run → account → environment check
  (O180).
