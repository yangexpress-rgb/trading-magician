# ADR 0083: Invite codes keep their first four characters

- **Status:** accepted
- **Date:** 2026-11-12
- **Design refs:** design v1.2 row N236. Amends ADR 0026 (codes stored as hashes) and ADR 0037
  (admin page)

## Context

Yong asked on 2026-11-12 to see the invite code in the admin list, so he knows which code he
created and who used which. Codes are stored only as SHA-256 hashes (ADR 0026), so a leaked
database row cannot be redeemed, and the plaintext of a code is shown once, right after minting.
The list already showed who used each code, but not the code or who created it.

## Decision

- **First group of four.** Minting stores each code's first group of four (`code_hint`, checked
  to be exactly four characters from the code alphabet) next to its hash. The list shows it as
  `ABCD-…`. The other twelve characters (60 bits) stay hash-only, so a leaked row still cannot be
  redeemed or brute-forced cheaply, and a lost code still cannot be shown again.
- **Created by.** `invite.created_by` records the admin who minted the code on the admin page;
  the list shows their email. Codes minted from the command line have no creator and show
  "Command line".
- **Existing codes.** Their plaintext was never stored, so their first four characters cannot be
  recovered; the list shows "Not kept". Their creator is backfilled from the `invite.minted`
  audit event written in the same transaction (same timestamp, `adminId` in its context).

## Alternatives

- **Store the whole code, encrypted with the credentials master key.** Lets the admin page show
  and copy any open code again, but a code becomes readable by anyone holding the database and the
  key. Not needed to tell codes apart; can be added later if Yong wants to resend lost codes.
- **Store the whole code in plain text.** Rejected: it undoes ADR 0026.

## Consequences

- Migration 0085 adds `code_hint` and `created_by`, and replaces `admin_mint_invites` (now takes
  the hints) and `admin_list_invites` (now returns hint, creator id and email).
- The `invites:list` command prints the first group too.
