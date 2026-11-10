# ADR 0071: Many strategies may refer to one theory; Esc closes any dropdown

- **Status:** accepted
- **Date:** 2026-11-10
- **Design refs:** design v1.2 rows N199 and N200, open point O140. Amends ADR 0054 (D6)

## Context

On 10 November 2026 Yong asked: "For each strategy, when i link it to a theory ... 1. one theory
can be referred by multi strategies. there shouldn't be a 1 to 1. 2. in any drop down list, i
should be able to press the key "esc" to cancel the drop down and back to initial display."

ADR 0054 D6 allowed one live strategy per Library record: a unique index on
`strategy.library_entry_id`, and linking a theory another strategy used was refused ("already
built by … — unlink that strategy first", or "built in another member's Strategy Lab").

## Decision

- **Many-to-one (N199).** Migration 0082 replaces the unique index with a plain partial index, so
  any number of live strategies, in any member's Strategy Lab, may refer to the same theory.
  Linking is refused only for a retired theory.
- **Built link.** The record's `built_strategy_id` stays as the one strategy that keeps it Built:
  the first strategy to refer to it. When that strategy stops referring (re-pointed, moved to a
  new record, deleted), the link moves to the oldest other strategy of the same member that still
  refers to it, with a history note ("still built by …"); the record reads Not built only when
  none is left. Clearing the link from the Library's edit form follows the same rule.
- **Theory page.** A theory lists every strategy of the viewer that refers to it ("Built
  strategies"); other members' strategies stay private, as before.
- **Copies.** Duplicating a strategy that refers to a theory makes a copy that refers to the same
  theory. A strategy whose record was auto-created from it refers to none, so its copy still gets
  a record of its own.
- **Esc (N200).** Esc closes any open dropdown and puts the display back as it was: the theory
  search under a strategy's name closes with the line unchanged and the focus back on it, and an
  app-wide handler closes open `<details>` dropdowns (such as the screener's Columns list),
  innermost or most recently opened first, returning focus to its summary. Native `<select>`
  lists and dialogs already close on Esc. Components that handle Esc themselves (inline rename,
  dialogs, chart cursors) are left alone.

## Consequences

- Strategy sharing is unaffected: it already checks that a shared strategy refers to the record.
- O140 (confirmed by Yong 2026-11-10): if member A's strategy holds the built link and member B's strategies also refer to the
  theory, the theory reads Not built once A's strategies all stop referring, because the server
  cannot read B's workspace on A's behalf. B's strategies keep their theory.
