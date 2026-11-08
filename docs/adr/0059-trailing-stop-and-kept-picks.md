# ADR 0059: Trailing stop, and Selection groups that keep their picks

- **Status:** accepted
- **Date:** 2026-11-08
- **Design refs:** §6.4, §6.6, §6.9; design v1.2 rows N147 to N150, open points O115 and O116.
  Builds on ADR 0040 (Selection groups), 0049 (Exits list) and 0053 (expected-move exit)

## Context

Yong asked for a test strategy: watch every S&P 500 stock from a day before to a day after its
earnings, buy one whose price jumps, and sell it once the price falls more than 1% from its highest
since the purchase. The Lab could express the window (ADR 0058) and the jump, but not the exit: the
ATR stop is fixed at entry and does not trail. It also could not hold a pick past the window: a
Selection group sells every holding that leaves the top N at the next rebalance, so a daily group
would sell the stock the day after the jump. Yong chose to add a real trailing stop.

## Decision

- **A trailing stop exit rule.** `{ kind: 'trailingStop', percent }`, with percent above 0 and below
  100, at most one per Exit. The peak starts at the average entry price and follows the best daily
  close since Entry filled (the highest for a long, the lowest for a short). A daily close more than
  `percent` % past it exits every leg at the next bar, by OR with the Exit condition and the other
  rules; the close is checked against the peak before that close. The first Entry leg's instrument is
  watched, as with the ATR stop (a warning says so for several instruments). The back test keeps the
  peak with the cycle; the paper runtime stores it in the cycle state (`trailPeak`). Exit reason
  `trailing_stop` (migration 0076 widens the back test trade check).
- **Daily closes, not intraday highs.** Like the other stops, it reads daily closes on the run's price
  basis, so "highest price" means the highest daily close (O115).
- **Keep each pick until its own exit.** A Selection group gains `keepHoldings`. With it, a rebalance
  never sells a holding; each pick leaves only by the Exit condition or an exit rule, and new picks
  still enter at each rebalance, each sized at 1/N of the template leg, so more than N can be held
  at once (O116). Without it, nothing changes.
- **Builder.** The Exits list gains "+ Trailing stop" (default 5%); the Selection group gains "Keep
  each pick until its own exit", and the rebalance-exits note says when it is off.

## Consequences

- Trailing exits can be back tested and run on paper for fixed legs and per-leg conditions. A
  Selection group over the S&P 500 remains back test only (N13).
- Saved strategies are unchanged: both fields are optional and absent on every existing strategy.
