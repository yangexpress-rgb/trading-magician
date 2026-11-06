# ADR 0028: Exit orders pre-filled from Entry

- **Status:** accepted
- **Date:** 2026-11-02
- **Design refs:** §6.6

## Context

Yong asked for Exit orders to start out as the opposite of the Entry orders, so most strategies
need no Exit legs typed by hand, while the user can still change them freely.

## Decision

- **Mirror rule** (`mirrorEntryOrders` in `@tm/domain`). Each Entry leg gets one Exit leg on the
  same instrument and account: Buy becomes Sell and Sell short becomes Buy to cover, with the same
  share count. A leg sized as a cash amount, % of equity or by risk can't be undone share for
  share, so its Exit is a Close of that instrument (one Close per instrument and account). Exits
  are market orders, good for the day, sent as soon as Exit qualifies; extended hours follows the
  Entry leg. Names are "Exit …", made unique across both phases.
- **Follow until edited, no flag stored.** The editor re-fills Exit whenever Entry orders change
  _and_ the Exit legs are still exactly what the mirror rule would produce (ignoring leg ids), or
  there are none. Changing any Exit field, or adding or removing an Exit leg, makes Exit the
  user's own and it stops following. Because this is derived from the definition, it behaves the
  same after a reload and needs no schema change.
- **Ids are kept.** A re-fill reuses the existing Exit leg ids in order, and a sequential
  submission order (`execution.legOrder`) drops removed Exit legs and appends new ones.
- **Back to the mirror on request.** When Exit has diverged, or is empty while Entry has legs,
  "Match Entry orders" re-fills it after a confirmation.
- Editor only: validation, the back tester and the runtime are unchanged, and saved strategies
  keep their Exit legs until the user edits Entry.

## Consequences

- An Exit leg that a user deliberately removed comes back on the next Entry edit when no Exit legs
  remain. Adding any Exit leg of their own stops that.
