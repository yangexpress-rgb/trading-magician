# ADR 0061: Back test results by cycle

- **Status:** accepted
- **Date:** 2026-11-09
- **Design refs:** §7.2, §7.3; design v1.2 rows N157 to N166, open points O122 to O127.
  Builds on C19 ("What happened"), N12 (selection rounds) and ADR 0059 (trailing stop)

## Context

Yong asked on 9 November 2026 for back test results grouped by cycle, then by order, with Entry
against Exit and the conditions, because "there is no direct visibility of one cycle, one trade,
and one leg". The results page showed one cycle in five places, each sorted differently: the Entry
bar log (newest first, without a cycle number), the Entry orders table, the Exit bar log, the Exit
orders table and the Trades table, which wrote the legs as text and gave P/L for the whole cycle
only. A proposal with mockups (N157 to N166, O122 to O127) was approved the same day.

Three gaps in what the engine kept made a cycle view impossible to build exactly from the stored
result: an Entry bar didn't say which cycle its firing opened, P/L was kept per cycle and per run
but not per instrument within a cycle, and the trailing stop kept no peak or level.

## Decision

- **The cycle is the unit of the results (N157).** A Cycles list, one row per cycle, replaces the
  Entry and Exit report cards and the Trades table as the main view. It includes cycles with no
  trade row (an Entry still working when the test ended), so every planned cycle shows.
- **A cycle opens inline (N158 to N160, O122).** The card puts Entry beside Exit, each with its
  signal (the bar that fired and every condition's values on it, or the stop figures, or the
  selection round row, N162) and one box per leg order. Under them, the cycle's own Exit checks and
  stops, then a legs table pairing each instrument's Entry legs with its Exit legs (N159). The list
  is an ARIA table of grid rows rather than an HTML table, so the open card takes the list's width
  instead of the widest table row's.
- **Nothing is removed (N164, O124).** The earlier sections move into one collapsed "Rules and full
  logs" section, whose title shows the number of warnings.
- **The engine records the links (N166).** Each Entry bar whose firing opened, added to or
  triggered a cycle carries its cycle number (as Exit bars already did). The result gains
  `cycles`: per cycle, each instrument's gross P/L, costs and net P/L, from the same position
  figures as the trade, and the trailing stop's last check. Both live in the run's stored result
  JSON, so there is no migration and the `backtest_trade` table is unchanged.
- **Behaviour is unchanged.** The new fields explain decisions and change none: the regression
  fingerprints (`behaviour` in `corpus-codec.ts`) leave them out, and every recorded fingerprint
  still matches.
- **Older runs still read.** Without `cycles` and Entry bar cycle numbers, the card matches the
  Entry bar to the cycle's Entry order by decision time and works out leg P/L from the fills
  (borrow costs, which aren't in the fills, are then left out).

## Consequences

- The "Download trades (CSV)" export is unchanged; "Download cycles and legs (CSV)" (N165) is built
  in the browser from the same data, one row per instrument per cycle.
- Stored results grow by one small record per cycle; selection strategies with hundreds of cycles
  add a few tens of kilobytes.
- The list's address carries `?cycle=N`, so a cycle can be bookmarked or sent.
- Marking cycles on the equity chart (O126) is left for a follow-up.
