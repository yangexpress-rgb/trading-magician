# ADR 0055: Strategy Library v2 — sequence-first numbers and a fuller record

- **Status:** accepted
- **Date:** 2026-11-08
- **Design refs:** §5.3, §13, §19; design v1.2 rows N107 to N115, open points O81 to O92; the
  brief "Strategy Library v2 — sequence-first numbers + a fuller strategy record" (Yong,
  2026-11-08: §1 convention v2 and the renumbering, §2 the nine fields and their backfill, §3
  acceptance checks). Builds on ADR 0051 (the Strategy Library) and ADR 0054 (Strategy Lab
  numbering)

## Context

Convention v1 numbers lead with letters (`SDS-0001`), so entries sort by letters before sequence
and the sequence, the one part that never repeats, is hard to read. Yong asked for numbers that
lead with the sequence, for every existing entry to move to them without breaking a link or a
bookmark, and for the record to answer more questions a person asks before building a strategy:
which way it trades, with what numbers, how it sizes and stops, how often it rebalances, what it
picks from, how far it has been tested, what can go wrong and what data it needs.

## Decision

- **Convention v2** (brief §1.1, §1.2): record type, a five-digit sequence, a hyphen, asset class
  then timeframe (`S00001-SD`). Same code tables as v1. `convention_versions` gains `layout`
  (letters-first or sequence-first) and `sequence_digits` (4 or 5); the domain composes and parses
  both shapes and reads each number through the version that issued it. The database composes
  numbers with the same rules (`strategy_library_compose`), so the insert trigger and the domain
  agree under either version.
- **Renumber everything once, under control** (brief §1.3, O81). `library:renumber-v2` plans from
  the stored sequence and codes, checks each result against the brief's table (sequences 1 to 31)
  and against what v1 would issue for the same codes, and refuses on any difference, missing
  related mapping or collision. Apply runs in one transaction: add the v2 row (effective that day,
  UTC), renumber every entry, write a history row each, rewrite related lists, verify, commit.
  Re-running is a no-op; the counter never moves.
- **Immutable numbers keep one door** (N110). The update guard still forbids changing a number,
  except inside `strategy_library_renumber`, a SECURITY DEFINER function revoked from PUBLIC. It
  sets a transaction-local marker naming the entry and checks it runs as the function's owner, so
  a forged setting from the app login is refused; the only columns it may change are the number,
  the convention version and `former_numbers` (exactly the old list plus the old number).
- **Former numbers resolve** (N109, O85). `former_numbers text[]`, unique across entries by a
  trigger and indexed (GIN). `resolveLibraryEntryRow` finds an entry by current or former number
  (current wins) and is used by the entry page (redirect), the API, the related-entries check
  (stores the current number), the Library search, and the Strategy Lab search and link.
- **Thirteen more seed entries** (N111, O91). The short-term entries 19 to 31 are part of the seed,
  so the library the brief renumbers exists everywhere. Fresh installs seed 31 under v1 and
  renumber in the same transaction; an 18-entry library gets 19 to 31 at start-up only while the
  counter reads 18, and otherwise registers nothing and warns.
- **Nine fields** (brief §2.1, §2.2; N112): direction, parameters, position sizing, stop loss,
  rebalance schedule, maturity, key risks, data needs and universe, as columns (text, jsonb and
  text[]) with database checks that mirror the domain schema. "Not specified" is a value, shown as
  such, never a blank (N113). An edit that sends none of the nine keeps what is stored, so an
  older API client cannot wipe them (N114).
- **Backfill from the record's own words** (brief §2.3, O86; N115). `LIBRARY_V2_BACKFILL` holds the
  values for the 31 seed entries by seed key, with a source for each and notes on judgement
  calls; the three worked examples are copied exactly. `library:backfill-v2` prints a dry-run
  report and applies only with `--apply`; it never overwrites a value someone wrote, and derives
  maturity from completed back tests of the linked Lab strategy (O84). History rows written by the
  renumbering and the backfill show as by "the system".

## Consequences

- Every number a person or document has used keeps working; v1 numbers are no longer issued.
- The brief's table is the authority for sequences 1 to 31: a library whose entries 19 onwards
  were taken by other records (O91) cannot be renumbered until Yong decides how to close the gap.
- Maturity "Back tested" reflects the database when the backfill runs, not the brief's count of
  nine linked entries; re-running after more links are made fills the rest (O84).
- Data needs and schedules that the fixed lists do not cover stay in the free-text fields (O89,
  O90); extending the lists is a later convention or schema change.
- Out of scope: rewriting old numbers inside prose (O85), a link table for per-workspace builds
  (ADR 0054, O77).
