# ADR 0033: Account deletion and the 30-day purge

- **Status:** accepted
- **Date:** 2026-11-05
- **Design refs:** §4.2, §20 #14; design v1.1 C6 and deviation D1

## Context

The approved retention decision (§20 #14) is that a deleted account is purged 30 days later, while
order and audit records are kept without personal details. The build used Better Auth's own
`deleteUser`, which removed the user row at once. Every tenant table cascades from the user, so
order records went with it, and the append-only triggers on order and audit tables made the
cascade fail for anyone who had traded.

## Decision

- **Deleting is two steps.** Settings › Security asks for the password and a typed `DELETE`. The
  server action (`deleteAccount`) then, in the tenant's transaction, stops every running strategy
  with "cancel working orders" and records `account.deleted` (`prepareAccountDeletion`); on the
  auth connection it sets `user.deleted_at` and ends every session. Better Auth's `deleteUser` is
  turned off, and a `session.create` hook refuses sign-in for a deleted account ("This account has
  been deleted.").
- **The purge** is the SQL function `purge_deleted_accounts(days, limit)` (migration 0048), called
  by the worker's hourly prune (`purgeDeletedAccounts`). It refuses fewer than 30 days. For each
  account deleted at least that long ago it removes sessions, sign-in accounts, verifications,
  stored keys, back tests, notifications and research caches; keeps feeds, platforms, trading
  accounts and strategies (orders point at them) with their names replaced and keys cleared; and
  replaces the user's name and email (`deleted-<id>@deleted.invalid`). Order intents, broker
  orders, order events, fills, positions and the audit trail stay as they are, and
  `account.purged` is recorded.
- The user row stays as a tombstone, so no cascade runs. Tables force row-level security, so the
  function is `SECURITY DEFINER` and the owner has `purge_owner` policies that reach only accounts
  already marked deleted. Only `tm_secrets` (the worker) may execute it.

## Consequences

- An email address stays taken until the purge. Signing up again with it within 30 days fails.
- Restoring an account within the 30 days is possible by clearing `deleted_at` by hand; there is
  no self-service undo yet.
- Backups still hold the data for their own 30 days (§20 #14), so personal details are gone from
  everything within 60 days of the request.
