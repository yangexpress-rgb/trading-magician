# ADR 0027: Position values in Exit rules

- **Status:** accepted
- **Date:** 2026-11-02
- **Design refs:** §6.4, §6.5, §7.2, §8.2

## Context

Yong asked for an Exit like "sell when the price is 5% above what I paid". Expressions could read
market data, indicators and constants, but nothing knew the price the Entry legs filled at, so a
take-profit or stop-loss relative to the entry could not be written.

## Decision

- **A new expression kind, `position`.** It names an instrument, a field and a bar series
  (interval, adjustment, session), like market expressions do. Fields:
  - `entry_price`: average price of the cycle's Entry fills in that instrument, before fees;
  - `gain_pct`: percent move of the mark from the entry price, positive when the position is
    winning (so a fall counts as a gain on a short);
  - `pnl`: unrealized profit or loss, (mark − entry price) × signed quantity;
  - `quantity`: signed quantity the cycle holds, 0 when flat.
- **The mark is the close of the latest completed bar at the expression's interval.** This keeps
  the back test and the runtime on the same price and the same cadence: a "1 hour" gain is checked
  at each hourly close in both. The mark series is loaded like any other market series, so
  staleness and missing data behave as they already do.
- **Per cycle, from fills.** The back tester counts its simulated Entry fills; the runtime counts
  the cycle's recorded Entry fills from whichever broker the account routes to (the built-in
  paper broker or Alpaca paper). With no Entry fill yet, every field except `quantity` is unknown,
  and an unknown condition never qualifies.
- **Where they can be used.** Exit conditions and Exit order limit and stop prices (for example a
  limit sell at `entry_price × 1.05`). Validation blocks them in Entry rules
  (`position_in_entry`), on instruments no Entry leg trades (`position_not_traded`), and with
  "crosses" operators, since a position value has no history (`cross_on_position`).
- **Shared evaluator.** `evaluateExpr` reads positions through an optional `position()` on the
  resolver; `withPositions` adds one cycle's positions to a market view. No logic is duplicated
  between the back tester and the runtime.

## Consequences

- Strategy definitions stay at schema version 1: the change only adds an expression kind, and
  every existing definition is still valid.
- Trigger events record position values alongside market values, so the Orders tab can show why
  an Exit fired.
- Trailing stops (a high-water mark since entry) are not covered; they need state across bars and
  would be a later addition.
