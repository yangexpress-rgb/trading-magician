# ADR 0066: Strategy Lab numbers start at S00001

- **Status:** accepted
- **Date:** 2026-11-09
- **Design refs:** design v1.2 row N183, open point O134. Amends ADR 0065

## Context

ADR 0065 started the Lab counter above every theory sequence that had ever had an S number, so
that no string named both a theory and a strategy; the first Lab number on staging was S00032.
Asked where Lab numbers should start, Yong answered: "let's keep the number range for theory and
strategy separate, so start from S00001 for strategy as well".

## Decision

- **No floor.** The Lab counter starts at 1: the first Lab number is S00001 (migration 0080
  replaces `strategy_lab_issue_number` without the floor).
- **One-time renumber.** Lab numbers already issued are renumbered once by migration 0080, from
  S00001 in the order they were issued, keeping their letters; the counter continues after the
  last. This is the only time a Lab number changes; the trigger guard is off for that one
  statement pair.
- **An S number is read by page.** Former S theory numbers keep opening their theories on
  Library pages (`/library/S00001-SD` opens T00001-SD, as before). In the Strategy Lab an S number
  is a strategy: `/strategy-lab/S00001-SD` opens your strategy. The Lab list's search still
  matches a theory's former numbers too, so searching S00001-SD lists your strategy S00001-SD and
  any strategy building T00001-SD. `/library/<S number>` opens your strategy only when no theory had that number.

## Consequences

- The same S string can name a former theory number and a Lab strategy; which one opens depends
  on the page. New theory numbers are T, so this applies only to the 31 numbers retired by ADR
  0064 (and their v1 forms are letters-first, which a Lab number never is).
- Staging's Lab numbers change once, on the deploy that adds migration 0080 (S00032-SD becomes
  S00001-SD and so on).
