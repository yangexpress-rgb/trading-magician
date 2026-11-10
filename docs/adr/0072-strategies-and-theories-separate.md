# ADR 0072: Strategies and theories are separate objects

- **Status:** accepted
- **Date:** 2026-11-10
- **Design refs:** design v1.2 row N205, open point O141. Replaces ADR 0054 D3 (auto-created
  records) and the "none referred for an auto-created theory" rule of N187; amends ADR 0056
  (Lab shares) and ADR 0071

## Context

On 10 November 2026 Yong could not link theory T00049-SD to strategy S00018-SN. T00049-SD is past
the 31 seed theories, so it was a record auto-created from another Lab strategy (ADR 0054 D3), and
a strategy linked to an auto-created record showed "Theory none referred" whatever strategy it was
made from: the link saved but looked as if it had failed. Yong then asked: "let's just make sure
theory and strategy are 2 separate data objects, and one strategy can have a reference of any
theory, therefore one theory can be referred by multi strategies."

## Decision

- **Separate objects.** A Lab strategy has its own S number (ADR 0065) and an optional reference
  (`strategy.library_entry_id`) to any theory. Saving, copying or accepting a strategy never
  creates a theory. The theory picker offers any registered theory, or "No theory" to stop
  referring. Many strategies may refer to one theory (ADR 0071); Built status follows the
  references as before.
- **Every reference is a theory.** Whatever a strategy refers to is shown as its theory, under its
  name and in the Strategy Lab's Theory column. The API drops `library.autoCreated` and the list's
  `libraryNumber` (the Theory column is `theoryNumber`).
- **Existing records (O141).** Records auto-created before this stay in the Library with their
  numbers, and so do their links (Yong's choice, 2026-11-10): each such strategy now shows its
  record as its theory, and can be pointed at any other theory or at none. No data changes.
- **Sharing a strategy (amends ADR 0056).** Any numbered strategy can be shared, with or without a
  theory. The share shows the strategy's S number and names its theory, if any. Accepting copies
  only the strategy: the copy gets its own S number and refers to the same theory (or to none, if
  that theory was retired since). Lab shares made before this (with a record snapshot) are
  accepted the same way. Library shares are unchanged: a copy of the record with a new number.
  Migration 0083 lets a Lab share name no theory and keys "one pending share" on the strategy.

## Consequences

- The auto-create code (`autoCreateLibraryRecord`) is gone; `autoCreatedRecord` in the domain
  package is no longer used by the app.
- A strategy with no theory is normal, not a draft state.
