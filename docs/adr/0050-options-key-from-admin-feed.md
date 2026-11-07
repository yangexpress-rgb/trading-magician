# ADR 0050: The options recording falls back to the admin's Alpaca feed key

- **Status:** accepted
- **Date:** 2026-11-07
- **Design refs:** §12, §17.3; design v1.2 row N85, open point O61. Changes ADR 0047's
  "Configuration" (the app's own Alpaca key)

## Context

ADR 0047 gave the global options recording its own Alpaca paper key (`OPTIONS_ALPACA_KEY_ID`,
`OPTIONS_ALPACA_SECRET_KEY`), because the recording serves every tenant and a tenant's sealed feed key
is opened only for that tenant's own work. On a one-person install that means entering the same key
twice: once as the Alpaca feed in Settings, once as worker variables. Yong asked (2026-11-07) for the
recording to share the existing key instead.

## Decision

- The worker's own variables still win. Without them, at start the worker asks the definer function
  `options_key_admins()` (migration 0066; tm_secrets only, user ids only) for the platform admins,
  oldest first, and opens the first one's oldest active Alpaca feed credential (paper only, as every
  credential). That key serves the closes, the history rebuild and the seed lookups.
- No other tenant's key is ever used. A member's feed is never read for the recording.
- The key is read once when the worker starts and kept in memory only; after changing or rotating the
  admin's Alpaca feed, restart the worker (a deploy does). The log says which source is in use, never
  the key.

## Consequences

- Staging and the Mac record options signals with no extra setting once the admin has an Alpaca feed.
- Everyone's options history depends on the admin's key: deleting or breaking that feed stops new
  signals (after the next restart) until another key is there.
- Alpaca's terms question (O36) is unchanged: values built from one account's key are shown to other
  users. It stays on the launch gate; a separate app key remains the cleaner setup for a public launch.
