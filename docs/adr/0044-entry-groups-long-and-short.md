# ADR 0044: Long and short entry groups in one strategy

- **Status:** accepted
- **Date:** 2026-11-07
- **Design refs:** §6.4, §6.9, §6.10, §7.3, §13.2; design v1.2 item 8, row N41; builds on ADR 0040
  (v1.2 builder) and ADR 0028 (Exit legs mirror Entry)

## Context

A strategy had one Entry and one Exit, so it could go one way only. A two-sided system, such as
a long 20-day breakout beside a short 20-day breakdown, each with its own 10-day exit, needed two
strategies working against each other on the same instrument and account. The v1.2 brief (item 8)
asks for entry groups with a direction, exits that belong to their group, explicit position rules
(one position at a time, no automatic flip), simple short modelling in back tests, a validation
message for accounts that can't short, and direction on every trade.

## Decision

- **Schema.** The strategy's own Entry and Exit stay where they are and are group 1. The Entry
  gains an optional `direction` (`long` | `short`). A new optional `groups` list (up to three) adds
  groups, each `{ id, label, entry, exit }` with the same Entry and Exit shapes. An Exit belongs to
  the Entry beside it, as it always has. A definition without `groups` or `direction` parses,
  hashes and runs exactly as before. Without a stated direction, a group whose Entry legs all sell
  short is short, otherwise long (`directionOf`).
- **One shared rule set.** A group runs as a strategy of its own: its "group definition" is the
  strategy with that group's Entry and Exit (`groupDefinition`). Back tests and paper runs both
  use it. Validation checks each group as it checks the strategy's own Entry and Exit, with
  problems reported under `groups.<n>` and named after the group.
- **Position rules.** A strategy holds at most one position at a time. On each evaluation the
  groups are checked in order, group 1 first; a group enters only when no cycle of any group is
  open, so the first group to qualify wins a tie. A group that qualifies while another group's
  position is open does nothing (`cycle_open` in the back-test log). Positions are never flipped.
  Each group keeps its own trigger state, so "when it becomes true" means true for that group's
  conditions. Several groups require Re-entry "One cycle at a time" (`groups_single_position`; the
  builder sets it when a group is added) and fixed legs, with no Selection group, per-leg
  conditions or best-by-metric (`groups_fixed_legs_only`).
- **Direction and legs.** A stated direction must match the Entry legs: long buys, short sells
  short (`direction_side_mismatch`). The builder's Direction picker sets both, and Exit legs that
  follow Entry flip with them.
- **Shorting.** Accounts that can't short already failed validation for a Sell short leg
  (`short_selling_unsupported`); that now covers every group. Instruments remember whether the
  broker lends them (`instrument.shortable`, from Alpaca's asset `shortable` flag at lookup;
  migration 0058). A short Entry on an instrument marked not shortable fails validation
  (`not_shortable`). When it is unknown, the back test allows it and says so in its assumptions,
  alongside the fact that margin requirements, margin calls and forced buy-ins are not modelled.
  The existing flat borrow cost (back-test input, 1% a year by default) still applies.
- **Reporting.** Back-test trades of a strategy with groups or a stated direction carry
  `direction` and the group's name (stored on `backtest_trade`, migration 0058). The trade list
  shows a Direction column (for older runs it reads the direction from the Entry legs), and "What
  happened" shows each group's conditions and orders. P&L already came from cash flows, so a short
  that gains when the price falls was already signed correctly; win rate and returns count it so.
  Paper runs record each group's evaluations as Entry trigger events, and a cycle remembers its
  group.

## Consequences

- Strategies that sell short without groups are unchanged; they are now labelled Short.
- The Performance tab already values short positions and P&L from fills; it is not split by
  group.
- Instruments looked up before this change have unknown shortability until looked up again.
