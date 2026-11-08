# ADR 0053: Exit beyond the expected move at entry

- **Status:** accepted
- **Date:** 2026-11-08
- **Design refs:** §6.6, §6.9; design v1.2 row N97 (replaces N66's "not built"), open points O48
  (resolved) and O71; options data brief v2 §10 item 10. Follows ADR 0045 (the ATR stop) and ADR
  0048 (which left this rule out)

## Context

ADR 0048 left out the exit "beyond the expected move at entry". It needs the expected move captured
when each cycle enters and kept with the cycle, as the ATR stop keeps its ATR. Yong asked for it on
2026-11-08.

## Decision

- **Rule.** A third Exit rule, `expectedMove`, with these fields:
  - `horizon`: 1 or 5 days, the recorded `expected_move_1d_pct` or `expected_move_5d_pct`;
  - `multiple`: a positive number;
  - `side`: `either`, `gain` or `loss`.
  - The builder starts it at 5 days, 1 expected move, either way.
  - One per Exit (`duplicate_expected_move_exit`). It is combined with the Exit condition by OR, like
    the time stop and the ATR stop.
- **Captured at entry.** When Entry is decided, the first Entry leg's expected move is read point in
  time from the options signals. Like any options metric, a signal older than 5 trading days is
  unknown. The move is kept with the cycle (`moveAtEntry`) and never re-read.
- **Fixed band.** Once the position opens: band = average entry price × (1 ± multiple × move).
  - `either`: a daily close outside the band exits at the next bar, labelled _Beyond the expected
    move_ (`exit_reason` `expected_move`).
  - `gain`: only the edge in the position's favour counts (the upper edge for a long, the lower for a
    short).
  - `loss`: only the other edge counts.
  - It watches the first Entry leg's instrument and closes every leg. A warning says so when Entry
    trades several instruments.
- **No signal at entry.** The cycle has no expected-move exit. The back test warns
  (`expected_move_unset`) and the other exits still apply.
- **Options feed.** The rule's metric counts as an options metric, so it needs the options feed and a
  recorded underlying (`missing_options_feed`). Back tests and paper runs load the signals for it.
- **Results.** Each trade stores the move at entry, horizon, multiple, side, entry price and band
  (`backtest_trade.expected_move`, migration 0068, which also allows the new exit reason). The trade
  list shows the band under the exit, and the trades CSV adds three columns.
- **Paper runs** capture and check the move the same way, in `runtime.ts`.

## Consequences

- The rule is close-based, like the ATR stop: an intraday move beyond the band that closes back
  inside it does not exit.
- A ranked Selection group or a group of legs watches the slot's instrument, which is the first
  Entry leg once a slot is bound.
- Open point O71: the band is fixed at entry and does not move with later expected moves. A
  re-centred or trailing band is not built.
