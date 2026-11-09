# ADR 0064: Library entries are theories, numbered T

- **Status:** accepted
- **Date:** 2026-11-09
- **Design refs:** design v1.2 rows N180 and N181, open point O133. Builds on ADR 0051 (Strategy
  Library), ADR 0054 (Lab numbering) and ADR 0055 (convention v2)

## Context

On 9 November 2026 Yong renamed the Strategy Library's items: "change the term 'strategy' in
strategy library to 'theory' … the strategies under 'strategy lab' should retain as strategy as
they're real strategies" (N180, interface wording only). The registration numbers still began with
S, the record-type letter meaning "Strategy" in convention v2. Asked whether that letter should
change, Yong answered: "these registration numbers are meant to be 'theory', so please change the
letter to 'T' for all".

A number never changes except through the single exempt renumber path (ADR 0055), and the
record-type letter could not change at all.

## Decision

- **Convention v3 (N181).** v3 is v2 with one record type, T (Theory): same sequence-first layout,
  five digits, timeframe and asset-class tables. It takes effect on the day it is added.
- **Every entry is renumbered S to T.** `renumberToTheories` (`packages/db/src/library-theory.ts`)
  runs right after the migrations and the seed check, in one transaction: it adds the v3 row and
  renumbers each v2 entry through `strategy_library_renumber`, which keeps the old number as a
  former number (S00001-SD and SDS-0001 both still open T00001-SD). Related lists are rewritten,
  one history row per entry says what changed, and the sequence counter is untouched; each new and
  old number is checked to resolve before committing. It is idempotent, leaves a library still on
  v1 alone, and a refusal is logged without blocking a deploy.
- **The renumber path may change the record-type letter (migration 0078).** When the target
  version lacks the entry's letter and has exactly one record type, the entry takes that one. The
  update guard allows a letter change only on that path; the app login still cannot change it.
- **New registrations get T.** `resolveRecordType` gives a registration the version's only record
  type when the one asked for is not in it, so a Lab auto-created record, a share accepted from an
  S snapshot or an older client asking for S all get T under v3 (and a fresh install, seeded under
  v1, still gets S until it is renumbered). Defaults move to T.

## Consequences

- Staging moves to T numbers on its next deploy; links, bookmarks and Related entries typed with S
  numbers keep working. Shares and notifications made before the change keep naming the S number
  they were made with; those links resolve too.
- Entry prose that mentions a number (for example "the daily version of this rule is S00004-SD")
  is content and was not edited; the number still resolves.
- A new install seeds under v1, renumbers to v2 and then to v3 in the same boot, ending in the same
  state as staging.
