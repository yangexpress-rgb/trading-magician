# ADR 0010: Order model and execution records

- **Status:** accepted
- **Date:** 2026-10-04
- **Design refs:** §6.6, §6.9, §8.2–8.6, §13.3–13.4, §16.2, §17.1, §17.4

## Context

Paper execution turns planned orders into real orders at a broker adapter. The design asks for
immutable order intents (§8.2), one canonical state model whatever the broker (§8.4), no duplicate
submissions on retry, and updates that may arrive late, twice or out of order (§8.5). Risk checks run
immediately before submission (§8.6), and the back test must trade the same way the runtime does.

## Decision

- **Shared sizing and risk.** `sizeOrder` and `checkPreTradeRisk` live in `@tm/domain` and are used
  by both the back-test engine and the paper runtime. The risk check returns every check it ran, with
  its limit and value, and that result is stored on the intent.
- **Canonical states.** `ORDER_STATES` follows §8.4. The app moves an order through the planning
  states one step at a time (`transitionOrder` rejects anything else, including skipping the risk
  check). Once an order is at the broker, `deriveBrokerOrder` computes its state, filled quantity,
  average price and fees from the _set_ of broker updates received. The result never depends on
  arrival order, repeats are ignored by event id, and a terminal state stays terminal. Property
  tests cover all three.
- **Tables.** `strategy_runtime` (one active per strategy, paper only), `strategy_cycle`,
  `trigger_event`, `scheduled_action` (deduplicated by key so a restart cannot schedule twice),
  `order_intent`, `broker_order` (current state, one per intent), `order_event` (the timeline),
  `fill` and `position_snapshot`. All use the tenant policy from ADR 0003.
- **Append-only records.** `order_intent`, `order_event` and `fill` grant the app only SELECT and
  INSERT, and a trigger stops even the owner from changing or deleting them. Rows go only through a
  foreign-key cascade when an account is deleted. `broker_order` is the one order table that
  changes, and only while its row is locked.
- **Idempotency.** Each intent carries a key derived from runtime, cycle, phase, leg and attempt
  (`tm1-` plus 32 hex characters of a SHA-256, short enough for common brokers' client order ids).
  The key is unique per tenant, so recording the same intent twice returns the first one, and the
  key is sent to the broker as the client order id.

## Consequences

- A risk-rejected or failed order is recorded with its reason but can never receive broker updates.
- Fills that arrive after a cancel are still applied, so an order canceled after a partial fill
  keeps the filled part, and a late fill can complete it.
- Fills beyond the ordered quantity mark the order `overfilled` for reconciliation (M3.5).
