# ADR 0075: Cycle card in three parts, with each condition's data

- **Status:** accepted
- **Date:** 2026-11-10
- **Design refs:** design v1.2 rows N218 to N220. Amends ADR 0061 (back test results by cycle);
  follows ADR 0073 (What to trade, Entry, Exit) and ADR 0074 (trailing stop in Exit when)

## Context

On 10 November 2026, after strategies were split into What to trade, Entry and Exit (ADR 0073),
Yong asked for the back test's cycle detail to follow the same three parts, and for it to show the
key data elements and their values, "so it's clear why each condition is met, and what data was
used in those steps".

The card put Entry beside Exit. A group's filter and ranking were only visible as a row of the
selection round (passes the filter: True), so the values behind the filter were not shown. A
group's Enter when that reads "this stock" was recorded on the bar log without a stock, so its
values were missing. A comparison showed its two compared values ("52.96 vs 52.91"), but not what
each side was or what a calculated side was worked out from.

## Decision

- **Three parts (N219).** What to trade across the top of the card, then Entry beside Exit. What
  to trade lists the specific assets, or for a group: the universe, when this stock was picked,
  members checked, the filter as it read for this stock with how many passed, and the ranking
  value, order and rank.
- **The engine records each pick (N219).** When a group opens a cycle, `CycleDetail.pick` keeps
  the Check Entry time, member, passed and ranked counts, rank and value, and the filter's and
  (when it reads "this stock") Enter when's checks for that stock.
- **Each condition with its data (N218).** Conditions are shown as their tree. Under each
  comparison: the data elements it read and their values, the values inside a calculation
  (`ConditionCheck.inputs`, kept by the engine), a position value's entry price, best close and
  close checked, a "Why" line, and the records read.
- **The run's plan (N220).** The result keeps `plan`: what it traded, Check Entry, Check Exit and
  whether Enter when was per candidate.
- **Behaviour is unchanged.** `pick`, `plan` and `inputs` explain decisions and change none; the
  regression fingerprints leave them out and every recorded fingerprint still matches. They live
  in the stored result JSON: no migration.

## Consequences

- Runs made before this show the earlier selection round on the What to trade side, with a note to
  run the back test again to see each pick's values.
- Stored results grow by one small record per group pick and a few values per calculated check.
