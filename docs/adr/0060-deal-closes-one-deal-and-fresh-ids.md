# ADR 0060: Deal closes from daily bars, one deal per merger, a chart that follows the selection, and fresh ids on Duplicate

- **Status:** accepted
- **Date:** 2026-11-08
- **Design refs:** §6.4, §6.6, §7.2, §11; design v1.2 rows N151 to N154, open points O117 to O119.
  Builds on ADR 0058 (earnings, deals and rates) and ADR 0029 (Research price charts)

## Context

Yong checked staging on 8 November 2026 and found four problems:

1. Research › Deals showed "—" for Close and Spread on almost every deal. The list read closes from
   the options recording, which covers 14 underlyings, so almost no deal target had one.
2. Arcosa's acquisition showed twice: D00933 from CRH's 8-K (target "Arcosa", no listing, low
   confidence) and D00935 from Arcosa's own 8-K (ACA, high confidence), same date, same $150.00.
   The tracker matched a second filing to a deal by CIK, or by the exact lower-case name, so a row
   without a CIK and a name with "Inc." never met.
3. After selecting AAPL in Research, the heading and the Earnings section showed AAPL but the chart
   still showed AGG's prices.
4. Duplicating parts of a strategy in the builder created duplicate ids, and saving reported "The
   definition has duplicate ids".

## Decision

- **Closes from daily bars (N151).** The worker stores each active deal target's latest daily close
  from Alpaca bars on the deal row (`last_close`, `last_close_date`), the same closes back tests read
  for `deals.spread_pct`. It runs once a day and again after the evening close, through the options
  recording's key, because the web app cannot open the bars route. The list computes the spread with
  the metric's own `dealSpread`, so a low-confidence or non-cash deal still has no spread, and a
  target with no bars has no close rather than a zero.
- **One deal per merger (N152).** Two rows with the same target (CIK, symbol, or the name without
  legal suffixes), announcement date and offer price are one deal. The higher-confidence parse is
  kept. The other row is not deleted: it keeps its id with `merged_into` set and is left out of the
  list, runs and status checks, so a deal id is never reused (O117). Its filing moves to a new
  `deal_filing` table under the kept deal and its status history is copied there. The tracker now
  links a second filing of a known deal instead of adding a row, finds a filing already read through
  either table, and matches targets by name key as well. The worker folds existing pairs on every
  pass; running it again changes nothing.
- **The chart follows the selection (N153).** A plain switch already updated the chart. The symptom
  came from keeping the previous chart on screen while the next one loaded: when the new chart was
  slow or failed, the old instrument's chart, readout and close stayed under the new heading (O119).
  The chart area now shows only a chart of the selected instrument; a range or bar change of the
  same instrument still keeps the old chart, dimmed, until the new one arrives.
- **Fresh ids on Duplicate (N154).** Conditions and groups were already copied with fresh ids. A
  duplicated leg copied its whole body and renewed only the leg's own id, so its leg condition kept
  the original's group and comparison ids. `cloneOrder` gives the leg, its price expressions and its
  leg condition fresh ids at every depth, and a copied leg gets a name no other leg has.

## Consequences

- Migration 0077 adds the two `deal_event` columns, `merged_into`, the `deal_filing` table (worker
  writes, app reads) and the `deal_closes` job. Nothing needs the staging database port: the merge
  and the first closes happen on the worker's first pass after the deploy (O118).
- The Deals list's footer now says where closes come from, and each extra filing shows as a link
  next to the deal id.
- No Strategy Library entry, Strategy Lab strategy or launch-gate setting is changed. Strategies
  already saved with duplicate ids are not repaired; they save once the duplicated parts are
  rebuilt, as before.
