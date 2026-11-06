# ADR 0037: The admin page

- **Status:** accepted
- **Date:** 2026-11-06
- **Design refs:** §16.1, §16.2, ADR 0026 (invite-only launch), ADR 0034 (operator audit),
  ADR 0036 (running without email)

## Context

Running the invite-only launch meant command-line jobs on the web service: minting and releasing
invite codes, resetting forgotten passwords, reading the audit trail with SQL. Yong asked for an
admin page in the app that does these, and can also lock and unlock someone's access.

## Decision

- **Who is an admin.** A row in `platform_admin`. It has no grants to any app role, and rows are
  written only by `pnpm --filter @tm/db users:grant-admin <email>` (and `users:revoke-admin`),
  which need the owner connection and write `admin.granted` / `admin.revoked` operator events.
  Nothing in the app can make someone an admin.
- **The web app keeps its two logins.** It does not get the owner connection. Every admin read
  and change is a `SECURITY DEFINER` function (`admin_list_users`, `admin_set_user_locked`,
  `admin_reset_password`, `admin_mint_invites`, `admin_list_invites`, `admin_change_invite`,
  `admin_audit_events`) that first checks `is_platform_admin()` for `app.user_id`, which
  `withTenant` sets from the server-side session, and refuses anyone else with
  `insufficient_privilege`. Because tables force row-level security, the owner gets policies on
  `user`, `session`, `account`, `entitlement`, `strategy` and `audit_event` that open only while
  an admin is the caller. The page itself also checks and answers 404 to non-admins.
- **Locking.** `user.locked_at`. Locking ends every session in the same transaction, and the
  sign-in hook refuses a locked account with `ACCOUNT_LOCKED`. An admin cannot lock themselves
  or another admin (revoke admin first). Locking does not stop the person's paper strategies or
  delete anything; unlocking restores access as it was.
- **Password reset.** As in ADR 0036, but from the page: a 20-character temporary password,
  hashed in the app, shown to the admin once; the person is signed out everywhere.
- **Invite codes.** Minted in the app (codes shown once, only hashes stored and passed to the
  database), listed by note and state (open, used, sign-up unfinished, expired or revoked).
  "Release" frees a code claimed by a sign-up that never finished; "revoke" expires an unused one
  at once. The command-line `invites:*` commands keep working.
- **Audit.** Every admin change writes an operator event (no user, actor `system`, ADR 0034)
  with `adminId` in its context: `admin.user_locked`, `admin.user_unlocked`,
  `admin.password_reset`, `invite.minted`, `invite.released`, `invite.revoked`. Locking,
  unlocking and resets also go in the person's own trail (`account.locked_by_admin`,
  `account.unlocked_by_admin`, `account.password_reset_by_operator`). No code, hash or password
  is ever recorded. The audit log tab shows the whole trail across accounts, newest first,
  filtered by kind or person.

## Consequences

- Granting admin on a deployment is a one-off command on the web service (see docs/deploy.md).
- The admin functions trust `app.user_id` as every tenant policy already does; code that sets it
  from anything but the session would break both.
