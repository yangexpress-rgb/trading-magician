# ADR 0102: Strategies do not pause for a just-sent order or for being full

- **Status:** accepted
- **Date:** 2026-11-18
- **Design refs:** design v1.3 §12.3, §12.4; N299, N300. Amends ADR 0014 and ADR 0096. Requested by
  Yong on 2026-11-17 after three strategies paused on staging ("why these pausing happened? do we
  have a mechanism to restart?").

## Context

On 2026-11-17 three strategies on the shared Alpaca paper account (••••4BD4) paused:

- **S00038, reconciliation mismatch at 9:30:19 AM New York.** Its COIN and SMCI Entry orders,
  queued from the evening before, were sent at 9:30:08. Alpaca did not accept them until
  9:30:20; until then it reports an order as `pending_new`, which the adapter turns into no
  updates. Reconciliation ran at 9:30:19 and read "no updates" as "an order the broker does not
  know", twice, and paused the strategy. Both orders filled minutes later.
- **S00039, repeated rejections at 4:05 PM.** The strategy ranks the top 20% of the S&P 500 by
  volatility each evening and buys $5,000 of each pick, with a $50,000 exposure limit. 70 picks
  passed its filter; the first 10 fit, and the other 60 were refused by the exposure check
  before they were sent. Those refusals counted as "3 orders in a row rejected", so the strategy
  paused itself every evening it ranked (it did the same on 2026-11-16).
- **S00033, repeated rejections at 3:00 PM.** Alpaca refused three buys of 68 SPY with
  "insufficient qty available for order (requested: 68, available: 67)". Another strategy on the
  same account (S00030) was short 67 SPY. Alpaca keeps one net position per symbol per account
  and refuses an order that would take it from short to long (or long to short) in one step.
  This is a real refusal, not a false alarm; see Consequences.

## Decision

- **N299: a just-sent order is given time to reach the broker.** Reconciliation calls a working
  order missing only when the broker said it has no such order (Alpaca 404) and it was sent at
  least 60 s ago, or the broker had nothing to report for it and it was sent at least 10 minutes
  ago (`MISSING_GRACE_MS`, `missingAtBroker` in `packages/db/src/reconcile.ts`). Until then the
  next pass looks again. Position checks are unchanged (N277 already allows for in-flight fills).
- **N300: refusals for being full do not count toward the rejections-in-a-row pause.** Orders the
  pre-trade check refused for strategy exposure, active orders, buying power or open positions
  (`CAPACITY_RISK_CODES` in `packages/domain/src/execution/risk.ts`) are left out when the worker
  looks at a strategy's latest orders (`recentOrderStates`). They are still recorded on the Orders
  page and notified with their figures (N287). Every other refusal, and every order the broker
  rejects or the app could not send, still counts: an order-size limit that refuses every order,
  or a broker that refuses every order, still pauses the strategy after 3.

## Consequences

- S00038's kind of pause at the open no longer happens. A truly lost order is noticed a little
  later (1 to 10 minutes instead of the next 60 s pass).
- A Selection that ranks more names than its limits hold takes as many as fit and keeps running.
  Its refused picks still appear on Orders.
- Opposite positions in one symbol on one shared account remain a limit of Alpaca accounts: a
  strategy that would flip the account's net position is refused by Alpaca and, after 3 such
  refusals, paused (correctly: it cannot trade as designed). The fix is to run strategies that
  trade the same symbol in opposite directions on separate Alpaca paper accounts, or a later
  change that splits such orders.
- Restarting: a paused strategy restarts with **Resume** on Orders, the Lab list or the strategy
  page. Pauses for broker silence, throttling or lost prices resume on their own (N283, ADR 0097);
  mismatch and repeated-rejection pauses still wait for a person.
