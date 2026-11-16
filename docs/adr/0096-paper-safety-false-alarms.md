# ADR 0096: Paper safety checks tell quiet prices and in-flight fills from real faults

- **Status:** accepted
- **Date:** 2026-11-16
- **Design refs:** design v1.3 §12.3, §12.4, §12.6; N276, N277, N278. Amends ADR 0014 and ADR 0087. Requested by Yong on 2026-11-16 after two strategies paused on staging at the open.

## Context

On 2026-11-16 two group strategies (S00039, S00038) sent market Entry orders at the open, queued
from Friday night. Both paused within six minutes, and neither pause was a real fault:

- **Stale prices (S00039).** The free Alpaca feed (IEX) sees a small share of the market. In the
  first minutes after the open the IEX trade and quote for FICO, AXON, IT and CMI went more than
  60 s without a change while the feed answered every pass. The watch also kept one
  `staleSince` for the whole strategy, so FICO quiet at 9:31 and IT quiet at 9:32 added up to
  "Live prices for IT have been unavailable for 64 seconds", which paused it.
- **Reconciliation (S00038).** Both strategies bought AXON and DDOG on the same account.
  Reconciliation polled working orders, then read broker positions; fills landed in between
  ("AXON: app 14, broker 21"), which looked like a mismatch and paused it.
- **Exposure.** The strategy exposure and buying-power checks counted positions only, so 20 Entry
  orders of $5,000 placed in one pass each passed a $50,000 exposure limit: about $90,000 was
  filled. (34 more were refused by the 20 active orders limit, as designed.)

## Decision

- **N276: a quiet price on a live feed is current.** Each pass, the feed is live when any price
  it gave for the strategy's watched instruments is within the stale-data threshold; when none
  is, the worker asks for a heartbeat quote (SPY). While the feed is live, a watched instrument
  whose price has not changed is not stale, and the pre-trade stale-data check counts its age as 0. A missing price is still flagged at once. Each instrument keeps its own stale-since time
  (`staleSinceBy`), and the pause comes when one instrument has been stale or missing for 60 s.
  Code: `apps/worker/src/feed-watch.ts` (`feedVerdict`, `effectivePriceAgeSec`), `watchFeed` in
  `apps/worker/src/runtime.ts`.
- **N277: reconciliation allows for fills in flight.** A position gap (broker − app) is not a
  mismatch while it fits within what the account's working orders still have to fill: up to the
  unfilled buys above, the unfilled sells below. Code: `packages/db/src/reconcile.ts`
  (`explainedByInFlight`). The next reconciliation, once the orders finish, still catches any
  real difference.
- **N278: unfilled Entry orders count toward exposure.** The strategy exposure, buying-power and
  risk-sizing checks for an Entry add the unfilled part of the strategy's working Entry orders
  (at their reference prices) and of each opening order recorded earlier in the same pass.
  Code: `pendingEntryGross` and `onOpeningRecorded` in `apps/worker/src/runtime.ts`.

## Consequences

- Quiet stocks on the IEX feed no longer pause strategies. A feed that stops answering, or one
  where nothing moves (heartbeat included), still pauses after 60 s.
- A real position difference that happens to be smaller than an order still working is reported
  one reconciliation later, once that order finishes.
- Group strategies with many picks now stop at the exposure limit in the pass that places them;
  the later picks are refused with "Strategy exposure" instead of going out.
- No migration: `staleSinceBy` lives in the runtime state JSON.
