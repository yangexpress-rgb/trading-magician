# ADR 0062: Strategy page in three sections

- **Status:** accepted
- **Date:** 2026-11-09
- **Design refs:** §5.2, §6, §7.1, §7.4; design v1.2 rows N171 to N177, open points O128 to O131.
  Builds on ADR 0049 (Strategy Lab simplification) and ADR 0061 (back test results by cycle)

## Context

Yong asked on 9 November 2026 for the strategy page to have "only 3 large sections": the strategy
itself with all its components, then the back test, then everything about execution. The page was
one column of eleven cards plus a narrow side column, not in that order:

- Two things were called Execution. The card after Exit held the order handling rules; the Start
  and Stop buttons sat in a small "Execution" block inside the Back Test card, between the run
  form and the run history. Both headings used the id `execution-heading`.
- Back testing was split across the Back Test card and the results card, with the start buttons
  between them.
- Versions and status history sat in a side column at the top, away from Start and Stop.
- Validation sat between the rules and the back test with nothing saying what it gates, and the
  instrument lookup sat between the Library entry and Entry.

A proposal with a screenshot of the page and mockups was approved the same day with all four
recommendations (O128 to O131).

## Decision

- **Three numbered sections (N171).** 1 Strategy, 2 Back test, 3 Execution, each a `section`
  labelled by a large heading with one line on what it holds. Every existing card sits in exactly
  one section. The side column goes, so the page is one full-width column. Cards keep their own
  `h2` headings: the back test results already nest headings to `h6`, so the cards are not
  demoted; the sections are landmarks named Strategy, Back test and Execution.
- **Jump links (N172).** The sticky save bar links to each section with a short state.
- **Strategy holds every saved rule (N173, O128, O130).** Order handling and Risk limits stay in
  section 1 because the back test simulates both; moving them under Execution would let a change
  quietly outdate a back test. The order handling card is renamed from Execution to Order handling
  on the strategy and version pages, and validation messages use the new name. Validation comes
  last in section 1 because it checks the rules above it and gates both the back test and the
  start. The instrument finder is a collapsed row (N174, O131).
- **Back test is one card plus results (N175).** "Run a back test" holds the form, the latest run,
  the current draft's standing, a running test and the history; the results follow.
- **Execution owns starting and stopping (N176).** A Ready to start card lists status, saved,
  validation and the latest back test with a mark each (the back test is a note, as before: never
  having been tested is a warning acknowledged in the start dialog, not a block). It holds the
  status buttons and the unchanged start and stop dialogs. An On paper card repeats the order
  handling in two lines and links to Orders and Performance filtered to this strategy. Versions
  and status history follow.
- **One source for the back test standing.** `backtestStanding` works out the latest completed
  run and whether the draft matches it once, for the back test card, the Ready to start card, the
  start dialog and the jump link. `useBacktests` moves up to the editor so both sections share it.

## Consequences

- Nothing about rules, back tests, orders or data changes; there is no migration.
- Browser tests that found Start and Stop inside the Back Test region now look in the Execution
  section, and the run form is the "Run a back test" region.
- The read-only version page and the Library pages keep their layout.
