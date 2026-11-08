# ADR 0054: Strategy Lab numbering — one registry, one counter

- **Status:** accepted
- **Date:** 2026-11-08
- **Design refs:** §5.3, §6.1, §6.2; design v1.2 rows N98 to N106, open points O72 to O80; the
  Strategy Lab numbering design brief (D1 to D10, worked examples, acceptance checks). Builds on
  ADR 0051 (the Strategy Library) and ADR 0049 (the Strategy Lab simplification)

## Context

Yong asked for the strategy number to be shown on the strategies in Strategy Lab. A strategy built
from a Strategy Library entry uses that entry's number and marks it Built; a strategy with no
entry gets a number of its own. Numbers must stay in the Library's single, gapless, never-reused
sequence (ADR 0051), so a Lab-only number space would leave holes in the Library's numbering.

## Decision

- **Every Lab strategy is one Library record** (brief §1, D1). `strategy.library_entry_id`
  (migration 0069, foreign key to `strategy_library_entries`) names it, and the number shown in
  Strategy Lab is that record's number. There is no second number space. A partial unique index
  allows one live strategy per record (D6).
- **The record's built link mirrors the strategy.** `built_strategy_id` / `built_strategy_owner`
  stay on the entry as in ADR 0051 (N92), and every change keeps the two sides equal in the same
  transaction, with a history note on each record it touches. Built status therefore follows the
  association in both directions.
- **Linking** (D2) uses the entry's number and consumes nothing. Switching from X to Y, or to a new
  record (D5), returns X to Not built; X keeps its number. There is no "no record" choice. Linking
  is refused, with a named error, for a retired entry and for one another strategy builds (D6):
  "SDS-0001 is already built by \<name\> — unlink that strategy first", or "… is built in another
  member's Strategy Lab".
- **Auto-create on save** (D3). A save (create, copy, or an edit of rules, name, description or
  tags; not a status or archive change) of a strategy with no record registers one through
  `registerLibraryEntry`, so the insert trigger issues the next number in the same transaction.
  The record is built from the strategy (`autoCreatedRecord` in `@tm/domain`): its name; entry and
  exit prose from the builder's "Reads as" text (moved to `@tm/domain/strategy-text` so the server
  writes the same words); assets from the traded instruments; category Other, frequency from the
  timeframe letter, turnaround Unknown; tagged `auto-created`; data requirements
  "Auto-created from Strategy Lab — complete in the Library."; and a `create` history entry. A
  draft with no Entry leg instrument gets no number (the builder says "Number assigned on first
  save with instruments.").
- **Letters** (D4) come from the strategy: one traded asset class takes its letter, several take A,
  watch-only indices are ignored, the S&P 500 universe is stocks. The timeframe is the calendar
  schedule if there is one (M, Q, Y, W), else the bars the conditions read (N, H, D, W), else D.
  The letters stay if the instruments change later (O66, O75).
- **Library-side changes stay in step.** Registering or editing an entry with a strategy link, and
  `library:link-seed`, move that strategy to the entry; clearing a link leaves the strategy with
  no record until its next save. A link held in another member's workspace can't be taken over or
  cleared from the Library, because their strategy would still name it. The register form and its
  flow are unchanged (D10).
- **Deletion** (D8): deleting a strategy returns its record to Not built; deleting an account does
  the same for all its records. Records and numbers are never deleted.
- **Display** (D7): a read-only Number column in the Strategy Lab list (also searchable), the
  number in the strategy header, and a "Library entry" card in the builder linking to the entry.
- **Backfill** (D9): migration 0069 carries any links already made (link-seed or the edit form)
  into the association. `library:link-seed` links the built seed entries by name with
  `matchSeedLinks` (clear one-to-one matches only), leaving out strategies named "Fixture …" and
  retired entries; it is a dry run unless `--apply`. Nothing else is backfilled: every other
  strategy gets its record on its next save.

## Consequences

- The Library's sequence keeps no gaps: every number belongs to a record (O72).
- A record has one built link, so one strategy across all workspaces builds an entry at a time
  (O77). Per-workspace links would need a link table.
- Run the backfill on the Mac before editing the ten built strategies; one edited first gets a
  record of its own, which stays (Not built) with its number after the backfill (O80). On staging
  the backfill runs only with Yong's OK.
- Out of scope (D10): editing Library records from Strategy Lab, back test summaries (Library O4).
