# ADR 0074: Trailing stop in Exit when

- **Status:** accepted
- **Date:** 2026-11-10
- **Design refs:** design v1.2 row N217. Amends ADR 0059 (the trailing stop rule); builds on
  ADR 0027 (position values in exits) and ADR 0073 (Check Exit, O144)

## Context

On 10 November 2026 Yong asked for the trailing stop to live in Exit when, under Position
(after Entry fills), rather than as a separate entry in the Exits list.

## Decision

- **A Position value.** `off_peak_pct`, "Off best close since entry %": how far the latest close
  is below the best close since Entry filled, in percent (above the lowest, for a short). "Off
  best close since entry % > 5" is a 5% trailing stop, and it can be combined with anything else
  in Exit when.
- **The peak.** It starts at the entry price and is updated with each Check Exit close, at the
  Check Exit bar size, with the trailing stop's own arithmetic (`trailingPeak`). Both engines keep
  it per holding only when Exit when reads the value. Before the first check it is unknown, so the
  condition cannot exit.
- **The builder** drops "+ Trailing stop" from the Exits list; "+ Trailing stop (in Exit when)"
  adds the 5% condition by OR on the first Entry leg's instrument (each pick, for a group).
- **Schema 4, converted on read.** `migrateV3` turns a trailing stop rule into that condition,
  OR'd into Exit when, where that exits on exactly the same closes: a group (its Exit has no Fire
  when), or Fire when "while true" with no confirmation or cooldown. Elsewhere, and where per-leg
  conditions or ranked legs watch each leg separately, the rule is kept as saved and runs as
  before (`trailing_stop_kept`). Stored documents are not rewritten.

## Consequences

- Converted strategies give the same fills in back tests (fixed legs and groups are tested); the
  exit is labelled Exit condition rather than Trailing stop, and the cycle card no longer shows
  the rule's level.
- Paper cycles keep `peaks` in the runtime state JSON. No database migration.
