# ADR 0076: The holding-period, ATR and expected-move exits in Exit when

- **Status:** accepted
- **Date:** 2026-11-10
- **Design refs:** design v1.2 row N221. Follows ADR 0074 (the trailing stop in Exit when); amends
  ADR 0049 (the Exits list), v1.2 item 4 (the time stop), item 9 (the ATR stop) and ADR 0053 (the
  expected-move exit)

## Context

After the trailing stop moved into Exit when (ADR 0074), Yong asked what the rest of the Exits
list did and why it was separate. Those rules read facts fixed at entry (days held, the ATR and
the expected move when Entry was decided), which Exit when had no values for. He asked for them
to move into Exit when too, on 10 November 2026.

## Decision

- **Position values.** `days_held` ("Trading days held", counting the day Entry first filled),
  `atrs_below_entry` ("Below entry, in ATRs at entry", with an optional `period`, 20 by default)
  and `expected_moves_1d` / `expected_moves_5d` ("Move since entry, in expected moves": positive
  in the holding's favour). The ATR and expected-move values read the close at the Check Exit bar
  size, as the stops did (O144).
- **Fixed at entry.** The engines fix each ATR and expected move Exit when reads for every Entry
  leg's instrument when Entry is decided, as the rules fixed theirs, and keep days held and the
  close with the cycle. Before the first Check Exit, or without the value at entry, the value is
  unknown and cannot exit.
- **The builder.** The Exits list keeps Left the group (a rebalance at Check Entry, not a
  condition) and rules kept as saved. Its buttons add a trailing stop, a holding period (≥ 5
  days), an ATR stop (the Entry's risk distance, else 2 × ATR(20)) or an expected move (beyond 1
  five-day move either way) to Exit when by OR.
- **Schema 5, converted on read.** `migrateV4` turns each rule into its condition, OR'd into Exit
  when on the first Entry leg's instrument, under the same rule as ADR 0074 (a group, or Fire when
  "while true" with no confirmation or cooldown, and no per-leg slots). An ATR stop without a
  distance, and every rule elsewhere, is kept as saved (`exit_rule_kept`). Stored documents are
  not rewritten.

## Consequences

- Converted strategies give the same fills in back tests (each rule, each expected-move side, and
  all three together are tested); their exits are labelled Exit condition, and the cycle card's
  bar checks show the ATR or move at entry and the close checked.
- Paper cycles keep `daysHeld`, `atrsAtEntry` and `movesAtEntry` in the runtime state JSON. No
  database migration.
- N222 (same day): the Exits section goes. Left the group is the What to trade setting "Sell a
  pick when it leaves the group"; the buttons and any kept rules sit under Exit when.
