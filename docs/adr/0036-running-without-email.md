# ADR 0036: Running without email

- **Status:** accepted
- **Date:** 2026-11-06
- **Design refs:** §16.1 (audit), ADR 0026 (invite-only launch)

## Context

Sign-up verified each address by email, and "forgot password" sent a reset link. Railway blocks
outgoing mail ports, so the app cannot send mail itself, and Yong chose not to add a mail service
(such as Resend) for now: "no email".

## Decision

- **`EMAIL_VERIFICATION=off`** on web turns email off. Sign-up still needs an invite code, then
  signs the person straight in. No verification or reset email is sent. The default stays
  `required`, so nothing changes unless the variable is set.
- **Only with invite-only sign-up.** The web app refuses to start with `EMAIL_VERIFICATION=off`
  and `SIGNUP_MODE=open`: without email, the single-use invite code is what admits a person.
- **The operator resets forgotten passwords.** `pnpm --filter @tm/web users:reset-password
<email>` (run where web's database URLs are set) gives the account a random temporary password,
  printed once, signs the person out everywhere, and writes
  `account.password_reset_by_operator` (actor `system`) to that person's audit trail. The hash
  and the password are never logged. Deleted accounts are left alone.
- **People change their own password** in Settings › Security, which also signs out their other
  sessions. The forgot-password page says to ask the person who invited you.

## Consequences

- Addresses are not proven to belong to the person. That is acceptable for an invite-only launch
  where the operator hands out each code, but must be revisited before open sign-up.
- A forgotten password needs the operator, by hand.
- Turning email on later is setting `SMTP_URL`, `MAIL_FROM` and removing `EMAIL_VERIFICATION`;
  accounts made without verification stay signed in and are not asked to verify again.
