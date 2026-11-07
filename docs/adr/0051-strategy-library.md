# ADR 0051: Strategy Library — a shared registry with permanent registration numbers

- **Status:** accepted
- **Date:** 2026-11-07
- **Design refs:** §5, §5.3, §13, §14; design v1.2 rows N86 to N95, open points O62 to O69;
  the Strategy Library design document (7 November 2026), Phase 1 (§10 steps 1 to 5)

## Context

Knowledge about strategies was split between research notes and Strategy Lab definitions, with
no single place saying what each strategy is and how it compares with the others. The Strategy
Library gives every strategy, built or not, one standard record and one registration number
that can be cited for good. The number must never change or be reused, two people registering
at the same moment must never get the same number, and the naming scheme must be able to
improve later without renumbering anything already issued.

## Decision

- **A shared catalogue, not tenant data.** `strategy_library_entries` has no `user_id`: every
  signed-in session reads every entry and may register or edit one (design D7). Row-level
  security still applies: each policy needs `app.user_id`, so nothing is readable outside a
  signed-in session, a registration must carry the registrant's own id, and an edit the
  editor's own id. The table owner (migrations, seeding, operator scripts) is not subject to
  these policies.
- **Numbers are issued by the database.** A `BEFORE INSERT` trigger (`SECURITY DEFINER`, pinned
  `search_path`) picks the convention version in effect, checks the three codes against its
  tables, takes the next value from the single row of `strategy_library_sequence` with
  `UPDATE … RETURNING` (the row lock queues simultaneous registrations), and composes the
  number. Whatever the client sent for the number, sequence, version, status or audit fields is
  overwritten. Because the counter is a row, not a Postgres sequence, a rolled-back registration
  rolls the counter back too: numbers have no gaps and are never issued twice. The application
  composes the same number with `composeRegistrationNumber` (`@tm/domain`) and rolls back on any
  difference.
- **Immutability in the database.** A `BEFORE UPDATE` trigger refuses any change to the number,
  sequence, convention version, code letters, registration time, registrant or seed key, refuses
  reviving a retired entry, and refuses a Strategy Lab link to someone else's workspace. Deletes
  and truncates are refused for every role, and the app has no delete grant. Convention versions
  are never updated or deleted; the edit history is append-only.
- **Versioned conventions.** `convention_versions` holds a label, an effective date and the
  three code tables as JSON, seeded with v1 by migration 0067. The current version is the one
  with the latest effective date on or before today (UTC). Each entry stores the version that
  issued its number, and its letters are always read through that version. A later version is a
  new row, added by migration.
- **The standard record.** Prose fields are text with a small Markdown subset parsed to data
  and rendered as React elements (never as HTML). Frequency and turnaround are JSON durations
  validated by `frequencySchema` and `turnaroundSchema`. Prior users and sources are JSON lists;
  each prior user needs a source. Related entries are registration numbers that must exist. The
  same schemas validate the API body and, again, the database layer.
- **Edits and history.** An edit sends every person-written field with the row version it
  started from and a change note; the changed fields are computed on the server and written with
  the note to `strategy_library_revisions`. Retiring writes a `retire` revision with its reason.
- **Strategy Lab links stay in their workspace.** `built_strategy_id` has no foreign key (a
  strategy is tenant data); `built_strategy_owner` records whose workspace it belongs to, and the
  link resolves to a name only for that person. Built status is derived from the link.
- **The seed is part of migrating.** `runMigrations` registers the 18 seed entries after the
  migrations, in one transaction, before any web instance can serve a registration, and checks
  each issued number against `STRATEGY_LIBRARY_SEED`; any difference rolls the seed back and
  fails the deploy. A seeded library is left alone. The seed definition is the only place the
  seed numbers are written in code.
- **Primary navigation** gains Strategy Library between Quantitative Research and Strategy Lab.

## Consequences

- The numbering rules hold even for a client that bypasses the app and writes SQL as the app
  login; the integration tests check this directly.
- Every database (local, the Mac, staging, production) starts with the same 18 numbers, and its
  next registration is 0019.
- The ten built seed entries are linked per workspace after deploy with
  `pnpm --filter @tm/db library:link-seed -- --email <address> [--apply]`, or by hand in Edit.
- Introducing convention v2 is a migration that inserts one row; nothing existing changes.
- Phase 2 (registering from Strategy Lab, drafting a strategy from an entry, back test summaries
  from linked runs) builds on `registerLibraryEntry`, `updateLibraryEntry` and the link fields.
