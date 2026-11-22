# ADR 0105: Safety closes say why; the trailing stop follows the strategy's bars; orders that cross zero on a shared account go in two parts

- **Status:** accepted
- **Date:** 2026-11-22
- **Design refs:** design v1.3 §8.11, §8.5, §9.3, §12.7; N306, N307. Amends ADR 0100 (when the
  strategy trailing stop is judged on paper). Requested by Yong on 2026-11-21 ("Diagnose the
  safety close trigger and fix the quantity-available bug"). Yong chose on 2026-11-22 to judge the
  trailing stop on the strategy's own bars.

## Context

**Safety closes.** From Tue Nov 17 to Fri Nov 20, 2026, staging sold whole strategy books every
morning between 9:32 and 10:37 New York time (S00038-SD, S00039-SD, S00018-SN, S00030-ED,
S00033-EN). The orders were labelled "Safety close" (`order_intent.source = 'system'`) and said
nothing else. The staging audit log shows a `runtime.strategy_trailing_stop` firing at the same
second as every one of them: the 1% strategy trailing stop (N291, ADR 0100), given to existing
strategies on Nov 16. Paper judged it every pass (about every 5 seconds) on live prices, while
back tests judge it once per bar; for a daily strategy that is the daily close. With about $50,000
invested, 1% is about $500, which the high-volatility picks gave back within minutes of the open.
The stop did not pause anything or open an incident, and its notification was lost among hundreds
of "Entry triggered" notifications, so the closes looked unexplained.

**Shared account.** S00033-EN (long 68 SPY) could not close: "insufficient qty available for order
(requested: 68, available: 34)", then "available: 33". The app sent the right quantity, S00033's
own 68. The "available" figure is Alpaca's: it keeps one net position per symbol per account, and
S00027-EN had shorted 34 (then 35) SPY on the same account, leaving the account long 34 (33).
Alpaca refuses any single order that would take the net position through zero. On Nov 17 the same
refusal stopped S00033 against S00030-ED's 67-share short.

## Decision

- **N306: every safety close states its reason.** `order_intent.close_reason` (migration 0102)
  holds it in words. `recordOrderIntent` refuses a `system` intent without one, and the check
  `order_intent_close_reason` refuses it in the database (`NOT VALID`: earlier safety closes keep
  no reason; nothing is backfilled). The reasons (`safetyCloseReason`,
  `packages/domain/src/execution/safety-close.ts`):
  - Trailing stop (whole strategy), a Risk limit, with its figures: how far below its best, the
    limit % and the money in positions.
  - Flatten at session end (N256).
  - A leg of a multi-leg order did not fill and the plan closes filled legs (§6.7).
    The reason shows on the order details ("Why the app closed this position") and under the order
    in the Orders list. Each pass that places safety closes logs a `safety_close` incident (new kind)
    naming the strategy, the symbols sold and the reason, with a notification "Safety close:
    positions were sold". It pauses nothing; a newer one for the same strategy resolves the older
    one. This replaces the "Trailing stop reached" notification.
- **Trailing stop on the strategy's own bars (amends ADR 0100).** On paper the stop is judged
  (`strategyTrailDue`) on every pass only for a strategy with an intraday rule; a daily strategy is
  judged when a new daily bar has closed, as the back test does. Going flat resets it at once. When
  it fires after the close, its market orders fill at the next open, like any daily Exit.
- **N307: orders that would cross zero go in two parts.** When Alpaca refuses an order with
  "insufficient qty available (requested: Q, available: A)" and 0 < A < Q, the Alpaca adapter sends
  part one for A at once, with client order id `<id>_1_<Q−A>`; once part one has filled, the next
  update read sends part two (`<id>_2`) for the rest, which Alpaca takes from a flat position. Both
  report under the app's own client order id, so the intent sees one order filling in two fills and
  reconciliation sees no stranger. Cancels reach part two; `orderUpdates` returns both parts. If
  Alpaca still refuses part two two minutes after part one filled, the order ends canceled with
  what filled and the refusal as its reason. The fake Alpaca now refuses orders that cross zero,
  counting what open orders hold, as Alpaca does.

## Consequences

- No strategy definition, risk limit, exposure-cap check or back test changes.
- A daily strategy's trailing stop no longer reacts to intraday dips; it can lose more than the
  limit between closes, as in the back test.
- Part two of a split order goes on the next pass after part one fills, a few seconds later, at the
  price then. A lost reply on part one followed by a retry when the account no longer needs the
  split could place both; the window is a lost reply plus a changed account within one pass.
- A refusal caused by other strategies' working orders (not positions) still leaves part two
  refused; the order then ends partly filled, with the reason stated.
