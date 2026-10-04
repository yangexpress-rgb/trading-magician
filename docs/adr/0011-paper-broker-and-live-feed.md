# ADR 0011: Paper broker and live demo feed

- **Status:** accepted (the §20 #1 and #2 defaults were confirmed 2026-10-04)
- **Date:** 2026-10-04
- **Design refs:** §6.5, §8.2–8.5, §9.2–9.3, §17.1, §17.4, §18 Phase 3, §20 #1–#2

## Context

Phase 3 needs one paper broker and live prices before any real provider is chosen (§20 #1, #2).
Real brokers and feeds come with Phase 4, so the contracts have to be right now and the first
implementations must need nothing external.

## Decision

- **Contracts in `@tm/domain`.** `LiveQuoteProvider` returns quotes that carry the provider time,
  the receipt time and the source (§17.1), and whether the session is open. `BrokerAdapter` covers
  capabilities, submit (idempotent on the client order id, which is the intent's idempotency key),
  cancel, a cursor-based update stream, per-order updates for reconciliation, and positions.
  Refusals are `BrokerRejectedError`; transient failures are `BrokerUnavailableError` and may be
  retried with the same client order id.
- **Live demo feed** (`@tm/market-data`). During the regular NYSE session the price walks through
  each generated hourly bar (open, the two extremes, close), so live quotes always agree with the
  bars a strategy evaluates and the back test used. Outside the session it returns the session's
  last quote, which ages into stale data. Quote size is 10% of the bar's average volume per minute.
- **Simulated paper broker** (`@tm/broker`). Market orders take the ask or bid plus the back test's
  5 bps slippage; limits fill when the quote reaches them, never through the limit; stops trigger on
  the last price. One fill takes at most one quote's size, so large orders fill over several quotes.
  Day orders expire at the close of the session they first trade in; IOC cancels the remainder and
  FOK cancels unless it can fill at once. Orders placed while the market is closed wait for the open.
  Its state lives behind `PaperBrokerStore`, separate from the app's orders, as a real broker's would.
- **Contract suite.** `describeBrokerContract` in `@tm/broker/testing` is the bar every adapter
  clears. The paper broker runs it twice: plainly, and through `withFaults`, which duplicates and
  reorders updates, loses submission replies and drops update reads.

## Consequences

- A strategy started outside market hours shows accepted orders that wait for the open.
- The paper broker never claims atomic multi-leg fills, so the multi-leg policy always applies.
- Adding a real broker means a new adapter that passes the same suite against its sandbox.
