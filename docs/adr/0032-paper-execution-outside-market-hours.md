# ADR 0032: Paper execution outside market hours

- **Status:** accepted
- **Date:** 2026-11-05
- **Design refs:** §6.8, §7.2, §8.6; design v1.1 deviations D2 and D3

## Context

Comparing the build with the design (design doc v1.1) found two places where paper execution
behaved differently from what the strategy says or from the back test of the same strategy:

- **D2.** The market-hours policy "Send in extended hours if allowed" had no effect. Only
  `cancel` was told apart; everything else behaved like `queue`, and an order went out in
  extended hours only when its own leg asked for it.
- **D3.** The back tester fills market orders at the next bar's open and cancels an opening order
  whose fill moved more than the price collar from the price it was decided at (ADR 0008). Paper
  execution checked the collar only against a limit price, so a market order decided overnight
  went to the broker at once and filled at the open whatever the gap.

## Decision

- **Extended hours if supported** (`sendsExtendedHours` in `@tm/domain`). Outside the regular
  session, a leg is sent as an extended-hours order when its account trades extended hours and
  the order is a day limit order, the only form brokers (Alpaca among them) take there. Any other
  leg waits for the regular session, as under `queue`. A leg that asks for extended hours itself
  is always sent that way. Validation warns about each leg the policy cannot send early
  (`extended_hours_policy_waits`), naming why.
- **Collar at the open** (`holdsForOpenCollar`, `collarBreach`). An opening market order (buy or
  sell short, not extended hours) decided while the regular session is closed, in a strategy with
  a price collar, is recorded and risk-checked as before but held in the Ready state instead of
  being sent. Once the session opens, the next pass compares the current price with the order's
  reference price. Within the collar it is sent; past it, it is canceled before submission with
  the reason ("The price opened at $74.20, 6.0% from $70.00 when the order was decided. The price
  collar allows 5%."). A cancel is not a reject, so it does not count towards the
  three-rejects pause; the leg then follows the strategy's leg-failure policy, as in the back test.
- Closing orders, limit and stop orders, and orders decided during the session are unchanged.
  The back tester is unchanged: it already behaved this way.

## Consequences

- A held order is visible on the Orders tab as Ready until the open. Stopping the strategy with
  "cancel working orders" cancels it there and then, since it never reached the broker.
- The leg timeout still counts from the open (`activeFromFor`), so holding an order does not
  shorten it.
- Stop orders triggered at a gapped open are still filled by the broker without this check; the
  back tester treats them as marketable. Closing that gap needs a broker-side protective limit.
