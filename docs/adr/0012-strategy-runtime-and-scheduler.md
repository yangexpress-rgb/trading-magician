# ADR 0012: Strategy runtime and timing scheduler

- **Status:** accepted (follows the Phase 3 §20 defaults, confirmed 2026-10-04)
- **Date:** 2026-10-04
- **Design refs:** §6.5–6.9, §8.1, §8.5, §12.4, §13.3, §18 Phase 3, §19.6

## Context

A started paper strategy has to evaluate its rules on live data, place Entry and Exit legs with
their timing, and survive worker restarts without placing anything twice (§8.5). The back-test
engine already encodes the Entry-first, Exit-second rules; the live runtime must make the same
decisions.

## Decision

- **One runtime per started strategy.** `startStrategy` creates a `strategy_runtime`; `stopStrategy`
  stops it and cancels pending scheduled actions. Workers claim runtimes with a lease through
  `claim_strategy_runtimes` (`FOR UPDATE SKIP LOCKED`), so any worker can pick up any runtime and
  only one steps it at a time. A stopped runtime keeps being claimed while it still has working
  orders, so their fills are recorded, but it places nothing new.
- **A pass is one tenant transaction.** It locks the user's paper broker, advances it, sends
  requested cancels, submits ready intents, syncs broker updates by cursor, reloads, then plans.
  If anything fails the whole pass rolls back and the next pass repeats it.
- **Pure planner.** `planCycle` in `@tm/domain` rebuilds each cycle from its durable records and
  returns what to submit, schedule, cancel or flatten. The back-test engine and the runtime share
  `stepTrigger`, `sizeOrder` and `checkPreTradeRisk`; `cycle.test.ts` checks the planner against the
  back-test rules.
- **Durable timing.** Delayed and relative legs become `scheduled_action` rows keyed by
  `(cycle, phase, leg, attempt)`, so rescheduling is an upsert and a different worker can fire them.
- **Exactly once.** Every leg becomes an immutable `order_intent` whose idempotency key comes from
  the runtime, cycle, phase, leg and attempt. Re-planning the same leg finds the existing intent;
  the broker treats the key as the client order id. Trigger events are recorded once per bar.
- **Paper broker state in Postgres.** `DbPaperBrokerStore` keeps simulated orders, updates and
  positions per user under tenant isolation, separate from the app's own order records.
- **Kill switch and pause.** Engaging the kill switch pauses every running runtime and is audited;
  paused or halted runtimes skip due legs instead of placing them.

## Consequences

- Live behavior can be tested deterministically by driving the clock (`runtime.test.ts`).
- Worker restarts lose nothing: state lives in the cycle records, schedule and intents.
- Real brokers in Phase 4 slot in behind the same pass; only the paper tick step goes away.
