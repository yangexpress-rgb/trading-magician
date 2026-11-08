# ADR 0056: Strategy sharing between members

- **Status:** accepted
- **Date:** 2026-11-08
- **Design refs:** §5.3, §6.1, §16.3; design v1.2 rows N116 to N124, open points O94 to O99; the
  "Strategy sharing design" proposal Yong approved on 2026-11-08 (decisions D1 to D5). Builds on
  ADR 0051 (the Strategy Library), ADR 0054 (Strategy Lab numbering), ADR 0055 (v2 numbers) and
  ADR 0037 (the admin page)

## Context

Yong asked for members, the admin included, to share a strategy with any other member. The
recipient accepts or declines; an accepted strategy is copied into the recipient's Library or
Strategy Lab, depending on where it was shared from, and shows "shared by x (user id)". There is
no email, the Library is one catalogue with one counter (ADR 0051), every Lab strategy is one
Library record (ADR 0054), and no member's name is shown to another member (O65).

## Decision

- **Member IDs** (D1). Every account gets `U0001`, `U0002`, … in sign-up order, issued by an
  insert trigger from a single counter row and never changed (migration 0071 backfills existing
  accounts oldest first). Settings › Profile shows it. Senders name recipients by exact member ID
  or email; members get no list of members. The admin picks from every member and may choose All
  members (D5).
- **A share is a snapshot** (D3). `strategy_share` holds the sender, the recipient (each with the
  name and member ID at share time), the source record, for a Lab share the source strategy, the
  snapshot, an optional note (500 characters), the status (pending, accepted, declined, withdrawn,
  expired), 30-day expiry (D4) and the copy's ids. The preview and the copy read only the snapshot,
  so the recipient never reads the sender's workspace and later edits never leak.
- **Where the copy lands.** A Library share registers a new record (the next number of the one
  counter) by the recipient, with every person-written field, the tag `shared`, `copied_from` and a
  history note "Copied from S… , shared by U…". A Lab share does the same for the strategy's record,
  then creates the strategy in the recipient's Lab (status Created, no versions, back tests or
  runs) linked to that record, so ADR 0054's one-strategy-per-record rule holds and the sender's
  number is never reused. Letters are the source record's. Every leg moves to the recipient's
  preferred paper account, or to a placeholder the builder asks to replace (O96).
- **Provenance** (D2). `received_share_id` on the strategy and the record is set once, at insert,
  and only for a pending share whose recipient is the caller (trigger). Strategy Lab shows a Shared
  badge, a filter and the line "Shared by Ann (U0002) on …, from S…"; the Library shows the line to
  the share's two people and only "Copied from S…" to everyone else, and gains "Registered by me"
  and "Shared with me" filters.
- **Database functions do every cross-member step.** `share_create`, `share_accept_begin` /
  `share_accept_finish`, `share_close` (decline, withdraw), `share_expire`,
  `share_close_for_account`, `share_lookup_member` and `share_list_members` are `SECURITY DEFINER`.
  They check the caller (`app.user_id`), statuses, limits (200 shares pending, O100; 20 sends an hour, each counting once, migration 0073, O101) and
  ownership, write both sides' audit events, and write the other side's notification unless muted.
  Accept locks the share row: the app makes the copies as the recipient inside the same
  transaction, and a second accept returns the first copy. Shares are readable by their two
  people only; the app has no write grant. The owner reads users, profiles and strategies and
  writes notifications and audit events under a transaction-local marker (`tm.sharing`) that only
  owner-role policies honour.
- **Notifications.** `share_received`, `share_accepted`, `share_declined`, mutable like the trading
  kinds, deduplicated per share. Withdrawn and expired shares notify nobody. A Sharing link beside
  Notifications counts pending shares.
- **Accounts.** Deleting an account withdraws what it sent and declines what it was sent; the purge
  clears names on shares and the snapshots of shares nobody accepted. Accepted copies stay.

## Consequences

- A Library copy is visible to every member, like any record; only its two people see who shared it.
- Copies never sync with their source; sharing again makes a new copy (O98).
- Maturity and other claims are copied as written; the history note names their source (O97).
- Out of scope: sharing back tests or run history, shared editing, groups of members.

## Amendment: sharing several at once (N125, 2026-11-08)

Yong asked to pick several strategies and share them in one go. The Library and Strategy Lab
lists gain a tick box on each shareable row, a header box for the page and "Share selected (n)".
`POST /shares` takes `sources` (up to 20) instead of `source`; every source is checked first, then
each goes to each person as its own share, in one transaction, so a refusal (naming the number)
shares nothing. Shares stay one per strategy and person, so accepting, declining and notifications
are unchanged. Migration 0072 raises the pending limit to 200 shares; migration 0073 makes the hourly limit count sends (20 an hour), not shares
(O100, O101).
