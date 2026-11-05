# ADR 0019: Trade ledger and cycle results

- **Status:** accepted
- **Date:** 2026-10-05
- **Design refs:** §10, §10.2, §14.3

## Context

Performance must come from reconciled fills, not from the orders the app meant to place, and §10.2
asks for a defined calculation method. Yong approved the Phase 5 defaults on 2026-10-05: first in,
first out matching, one trade per strategy cycle, fees as the broker reports them, and USD only.

## Decision

- **Books.** Fills match only within a book: one strategy runtime, one account, one instrument. A
  strategy's lots are never closed by another strategy's fills, even on the same account.
- **First in, first out.** A fill first closes lots on the other side, oldest first; anything left
  opens a new lot. A sale with nothing held opens a short lot, and a purchase covers short lots
  before it opens a long one. Gains are `(close − open) × quantity × multiplier` for longs and the
  negative for shorts.
- **Fees** are shared out by quantity. The closing fill's fee goes to the lots it closes; the opening
  fill's fee stays with the open lot and is charged when that part closes. Net is gross minus both.
  Today both paper brokers report no fees, so net equals gross.
- **Cycle results.** A closed lot belongs to the cycle and leg that opened it, so a pair trade is one
  result whose legs show their own gain or loss (an Entry leg's lots are closed by the Exit legs).
  A cycle is closed when none of its lots is open. Its capital is the cost of everything it opened,
  and its return is net over capital.
- **Computed on read.** The ledger is rebuilt from fills for the books in scope. Scope narrows whole
  books (strategy, account, instrument, mode), never dates, so lots always match against their full
  history; dates filter the results afterwards.
- **Pure core.** Matching lives in `@tm/domain` (`buildLedger`, `cycleResults`) with property tests:
  each book's open quantity equals its buys minus sells, holds lots on one side only, every fee is
  either charged or still pending, and a flat book's realized gross equals its sales minus purchases.

## Consequences

- The runtime's own count of a cycle's cash (`strategy_cycle.realized_pnl`) and the ledger agree;
  a worker test checks both against a hand calculation from the fills.
- Fills the broker reports for orders the app never placed carry no instrument or direction in the
  update stream, so they are not in the ledger. Positions the app cannot explain are found by
  comparing with the broker's positions (M5.2) and shown under "Outside the app".
- Daily equity is stored separately (M5.2) so the ledger need not be replayed for every chart.
