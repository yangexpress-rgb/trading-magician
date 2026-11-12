# ADR 0085: Keep whole invite codes encrypted for the admin page

- **Status:** accepted
- **Date:** 2026-11-12
- **Design refs:** design v1.2 row N238. Amends ADR 0083 (first four characters) and ADR 0026

## Context

After ADR 0083 the admin list showed only each code's first four characters, which read as a
column cut short. Yong chose (2026-11-12, decision card) to keep new codes encrypted so the list
shows them in full.

## Decision

- Minting on the admin page also stores each code sealed with AES-256-GCM
  (`invite.code_sealed`, `v1.` + base64url of nonce, tag and ciphertext).
- The key is derived with HKDF-SHA256 from the web app's `BETTER_AUTH_SECRET`
  (`inviteCodeKey`). Only the web app holds that secret, not the database or the worker, so a
  leaked database alone still reveals no code. No new Railway variable is needed.
- The list opens each sealed code and shows it in full. A code that can't be opened (minted before
  this change, from the command line, or after `BETTER_AUTH_SECRET` changed) falls back to its
  first four characters, or "Not kept".
- The hash still decides sign-up; the sealed copy is only for display.

## Alternatives

- **The credentials key pair (ADR 0015, ADR 0035).** The web app holds only the public key, so it could seal
  but not open. Rejected.
- **A separate `INVITE_CODE_KEY` variable.** Cleaner rotation, but needs a new Railway setting
  for little gain. Can be added later.

## Consequences

- Migration 0087 adds `code_sealed` and replaces `admin_mint_invites` and `admin_list_invites`.
- Rotating `BETTER_AUTH_SECRET` also hides earlier codes (back to first four characters).
