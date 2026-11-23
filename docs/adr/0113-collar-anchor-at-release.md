# ADR 0113: The price collar is anchored at release, never on a prior session

- **Status:** accepted
- **Date:** 2026-11-23
- **Design refs:** design v1.3 §7.2, §8.6, §12.3; N325. Yong's brief "Fix the price collar's anchor
  price" (2026-11-23). Amends ADR 0032 (collar at the open) and the back tester's collar (ADR 0008).

## Context

On Monday 2026-11-23 at 9:30:01 ET, S00046-ED (VIX spike fade, SVXY) had its Entry order canceled
before it reached the broker: "The price opened at $51.15, 6.1% from $48.19 when the order was
decided. The price collar allows 5%." The order was decided on Friday 2026-11-20 at 16:05 ET and
held as Ready for Monday's open (ADR 0032). The collar compared Monday's open with Friday's
decision price, so it measured the ordinary move across the weekend, the very move the strategy
bet on, not an anomaly. For volatile instruments (SVXY, UVXY, VXX) such a block is near-certain.

The collar exists to protect the seconds between deciding (or releasing) an order and sending it:
a bad tick, a stale quote or a flash move in that window. Its two prices must be sampled seconds
apart.

Where the anchor was sampled before:

- **Paper, held orders:** `submitReady` in `apps/worker/src/runtime.ts` compared the pass's quote
  with `order_intent.reference_price`, the quote at the decision (`placeLeg`), from an earlier
  session by construction.
- **Back tests:** `tryFill` in `packages/backtest/src/engine.ts` compared the fill's base price
  with `Order.reference`, the last close when the order was decided, however many sessions
  earlier; a market order decided at a daily close was canceled when the next open gapped more
  than the collar.

## Decision

- **Anchor at release (paper).** `releaseHeldOrder` in `apps/worker/src/runtime.ts` is the one
  place a paper collar anchor is sampled. The anchor is the **release snapshot**: the pass's
  latest price for the instrument when the order is released at the open. It must be from the
  session the order is sent in (`sampledInSessionAt` in `@tm/domain`: on or after that session's
  open, not after now); while the only price is older (Friday's close, a pre-market quote), the
  order waits as Ready. The price compared with it is read again from the feed at the send attempt
  (`LiveQuoteProvider.freshQuote`, which bypasses the pass's quote cache), so the two are seconds
  apart at most. `collarAtRelease` in `@tm/domain` decides: send, wait or block.
- **The decision price plays no part.** `referencePrice` is not an input to the release check, so
  no prior-session price can be an anchor. It is still stored on the order intent and used for
  exposure (unchanged).
- **A block keeps the protection.** Past the collar, the order is canceled before submission
  with a reason naming both prices, when each was sampled (New York time) and the anchor's source:
  "Not sent: the price moved 6.0% while the order was being sent, from $50.00 at 9:30:01 AM ET
  (release snapshot) to $53.00 at 9:30:03 AM ET (at the send attempt). The price collar allows
  5%." An `order.collar_blocked` audit event records both prices, both provider timestamps, both
  sources, the move and the collar. A release within the collar is logged with the same figures.
- **Back tests, anchored the same way.** An order's anchor is the last close when it was decided
  only while it works in the session it was decided in. From the first bar it sees in any later
  session (an order decided at a close and held for the next open, or a good-till-canceled order
  working into another day), the anchor becomes that bar's open: the session's first price the
  order sees, its release snapshot. A collar cancel's figures now carry `referenceAt`,
  `referenceSource` (`decision` or `release_snapshot`) and `priceAt`, and the order report names
  both prices and times.
- **Unchanged:** the collar percentage and every strategy's risk settings; the limit-price collar
  in the pre-trade risk check (it compares the limit with the price at the moment of the check);
  whether entry conditions are re-checked before an overnight order is sent (out of scope); order
  sizing; orders decided and sent in the same session.

## Consequences

- A market order decided at a daily close is no longer collar-canceled for a gap at the next
  open, on paper or in back tests. Daily back tests that used to show `collar_cancel` on gaps now
  fill at the gapped open; two recorded corpus fixtures change on purpose (#45, #55).
- A held order waits while its feed has no price from the current session yet. On a feed that is
  silent at the open this delays the send until the first current price arrives.
- Each held order costs one extra quote request at release (the fresh read), a few a day.
- Results stored before this change keep their old collar wording ("The next open was …").
