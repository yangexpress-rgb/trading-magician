# ADR 0034: Operator audit events for invite codes

- **Status:** accepted
- **Date:** 2026-11-05
- **Design refs:** §16.1, §16.2, Phase 6 plan M6.5, design v1.1 deviation D6

## Context

The launch is invite-only (ADR 0026), so the invite codes decide who gets in. §16.1 asks for
administrative actions to be audited, and M6.5 promised audited admin actions, but
`invites:mint` and `invites:release` wrote nothing; only a code being used was audited, as
`account.invited`. Every audit row belonged to a workspace (`audit_event.user_id` was required),
and minting a code belongs to no workspace.

## Decision

- **Operator events have no user.** `audit_event.user_id` may be null, and a check constraint
  (`audit_event_operator_is_system`) allows that only for `actor_type = 'system'`. The row is
  otherwise the same shape as every other audit event, in the same table, so one query over
  `audit_event` sees invite administration beside everything else.
- **Who may write and read them.** The table forces row-level security. Migration 0049 gives the
  owner connection (the one the operator scripts use) two narrow policies: append rows with no user
  as system events, and read rows with no user. The app role's policies match on the signed-in
  user, so operator events are invisible to every workspace and the app cannot write one.
- **Events.** `invite.minted`: one per batch, `resource_type = 'invite'`, context
  `{ count, note, expiresAt }`. `invite.released`: one per `invites:release` call, naming the
  invite by its id when a code was freed, context `{ count, note }` where count is 1 or 0 (0 when
  the code was unknown, unclaimed or already used by an account; the attempt is still recorded).
  Both are written in the same transaction as the change.
- **Never the code.** No event holds a code or its hash, in any spelling. Tests search the whole
  trail as text for each code, its normalized form and its hash.
- **Not audited.** The sign-up gate giving back its own claim when a sign-up fails
  (`releaseInvite` as the app role) is a rollback, not an administrative action; the successful
  use stays audited as `account.invited`.

## Consequences

Code that reads `audit_event.user_id` must allow null. Later operator commands (for example
granting a plan by hand) should use `recordOperatorAudit` rather than a made-up user.
