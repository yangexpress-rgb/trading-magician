# ADR 0065: Strategy Lab strategies have their own S numbers

- **Status:** accepted
- **Date:** 2026-11-09
- **Design refs:** design v1.2 row N182, open point O134. Builds on ADR 0054 (Lab numbering),
  ADR 0055 (convention v2) and ADR 0064 (theory numbers, T)

## Context

Since ADR 0054 a Lab strategy showed the number of the Library record it builds. ADR 0064 made
Library items theories numbered T. On 9 November 2026 Yong asked for "a numbering mechanism for
'strategies' in the strategy lab context … follow the rules we defined for theories, with the
leading letter 'S'".

Theory numbers were S numbers until ADR 0064 and still open their theory as former numbers
(S00001-SD opens T00001-SD). A Lab counter starting at 1 would issue the same strings.

## Decision

- **Own number, theory rules, letter S (N182).** A Lab strategy's number is laid out like a
  convention v3 theory number (sequence-first, at least five digits, asset class then timeframe)
  with record type S, for example S00032-SD. The two letters are derived from the strategy as for
  an auto-created theory record (ADR 0054 D4) and checked against the convention version in
  effect, whose label is stored with the number.
- **Own counter.** `strategy_lab_sequence` is a single-row counter, global across workspaces,
  separate from the theory counter. A trigger on `strategy` (`strategy_lab_issue_number`,
  migration 0079) issues the next number when the app sets the two letters, in the same
  transaction as the save, so a rolled-back save gives the number back. Once issued, the number,
  its letters, version and time never change (the trigger refuses), the app cannot write a number
  itself, and a number is never reused, deleted strategies included (unique indexes).
- **No collision with former theory numbers (O134).** Each issue starts above the highest theory
  sequence that has ever had an S number (current or former), so the first Lab number on staging
  is S00032 and no string names both a theory and a strategy. Old S theory links keep working.
- **When.** A save of a strategy with no number (create, copy, edit, accepted share) issues one
  through `issueLabNumber` (`packages/db/src/library-lab.ts`), right after its theory record is
  linked or created. Fixtures ("Fixture …") and drafts with no traded instrument get none.
  Strategies saved before this change are numbered oldest first by `numberExistingLabStrategies`,
  which runs after the migrations on deploy (idempotent; a refusal is logged, not fatal).
- **Theory link unchanged.** Every Lab strategy still builds one theory record (ADR 0054); that
  record keeps its T number and Built mirror.
- **Display.** The Lab list's Number column shows the S number (searchable, sorts by sequence),
  with "Theory T…" under it; the strategy header shows the S number and a "Theory T…" link.
  `/strategy-lab/<S number>` redirects to the strategy, and so does `/library/<S number>` for its
  owner. Sharing is unchanged: a Lab share sends the theory record with the strategy and is named
  by the theory's T number, and the recipient's copy gets a new S number of its own.

## Consequences

- Numbers in the Lab no longer match the theory numbers; the theory stays one click away.
- A database whose library is still on convention v2 (S theory numbers; tests only) could later
  register a theory with an S number a Lab strategy already has. Staging and new installs run v3.
- Shares, notifications and history written before this change name the theory number they were
  made with; those still resolve.
