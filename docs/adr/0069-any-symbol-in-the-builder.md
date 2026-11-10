# ADR 0069: Any symbol in the builder, no list to add to first

- **Status:** accepted
- **Date:** 2026-11-09
- **Design refs:** design v1.2 row N193. Amends ADR 0017 (real instruments) for the Strategy Lab

## Context

The strategy builder's instrument pickers offered only the instruments a person had already
found with the "Find a stock, ETF or index · N instruments added" card at the top of the
Strategy section (plus those their strategies used). To use a new stock in a leg or a condition,
they first had to look it up there, then pick it in the row. Yong: "i should not need to
specifically search and add a stock, etf or index in order to use it in a strategy definition.
if there is a pre-selected scope of assets, please disenable it. i should be able to select any
stock whichever is valid without maintaining a pre-selected scope."

## Decision

- **The finder card is gone.** No step adds instruments before they can be used.
- **Every picker takes any symbol.** Each instrument picker (legs, condition sides, statistics,
  options signals) ends with "Another stock, ETF or index…". Choosing it opens a symbol box under
  the picker; typing a ticker or company name and pressing Use (or Enter) picks it for that row.
  A symbol the editor already knows is picked at once; anything else goes through the existing
  lookup (ADR 0017, 0029): the worker confirms it with the person's US stock data feed, registers
  it and the row takes it. A company name that is not a ticker shows the closest listings to
  pick from. The found instrument joins every picker in the editor straight away.
- **Selection lists** ("My list of instruments") get the same box, "Add a stock or ETF to the
  list".
- **Indices.** A leg or list box that finds an index such as the VIX says it can be watched by
  conditions but not traded, and leaves the row unchanged; the index is still offered to
  condition pickers (v1.2 item 5).
- **What the picker lists** is unchanged: the instruments the person has looked up or their
  strategies use. Those are a convenience, not a scope: nothing outside the list is refused.
  Other people's lookups stay private, so the shared instrument table is not listed wholesale.
- **No data, back test or paper change.** A typed symbol is a registered instrument like any
  other, so data, back tests and paper runs work as before; existing strategies are unaffected.
  Each new symbol costs one lookup request to the person's feed, inside the per-key budget
  (ADR 0052); a symbol already known costs none.

## Consequences

- The Research stock picker already searched every US stock this way (ADR 0029) and is unchanged.
- The e2e Alpaca and VIX journeys now look symbols up from a leg's picker.
