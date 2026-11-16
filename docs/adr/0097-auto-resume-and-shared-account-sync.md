# ADR 0097: Shared account sync, throttling apart from silence, and automatic resume

- **Status:** accepted
- **Date:** 2026-11-16
- **Design refs:** design v1.3 §12.4, §12.6; N280, N281. Amends ADR 0087 and ADR 0096.
  Requested by Yong on 2026-11-16 after three strategies paused at 12:13 ET with "The paper broker
  has not answered for 61–66 seconds", asking that such pauses restart on their own.

## Context

Eight strategies ran on one Alpaca paper account. Each pass (every 5 s per strategy) asked the
broker for the account's new orders and fills, two requests each: about 190 requests a minute on
one key, before prices, reconciliation and valuations. Alpaca allows 200 a minute per key and
answers 429 beyond it. The worker treated a 429 like silence, so after 60 s of them it paused
strategies as "not answered". The broker was there all along.

Pauses for passing outages also waited for a person to press Resume, even once the cause had
long cleared.

## Decision

- **N280: one account sync for all its strategies.** An in-process gate (`AccountSyncGate`,
  `apps/worker/src/account-sync.ts`) lets one pass ask the broker for an account's updates per
  `RUNTIME_PASS_EVERY_MS` (5 s); the others in that window read the applied updates from the
  database and inherit the sync's outcome. Eight strategies on one account now send the account's
  update requests once, not eight times.
- **N280: "too many requests" is throttling, not silence.** An `AlpacaRateLimitError` marks the
  pass `throttled`, not `brokerDown`. The runtime keeps going (the request budget already backs
  off) and pauses only after 5 minutes of continuous throttling (`SAFETY.throttledPauseMs`), with
  "Alpaca has refused requests as over its limit for N minutes" under the existing
  `broker_disconnected` incident kind (no migration).
- **N281: automatic resume after passing outages.** A pause for broker silence, throttling or lost
  live prices records `autoPause` in the runtime state. Paused runtimes keep their passes; once the
  cause is healthy (the broker answers; the watched prices are current) for 30 s and the backoff
  has passed (1, 3 then 10 minutes for the day's first, second and third resume), the worker
  resumes the runtime through `resumeRuntime` (so the kill switch still blocks it), resolves the
  incident, audits `runtime.resumed` with `auto: true`, and notifies "… resumed on its own".
  After 3 automatic resumes in one New York day it stays paused and says so once.
- **Never automatic:** a pause whose reason has changed since (a person, the kill switch, a plan
  change), or any runtime with an open reconciliation mismatch or repeated-rejects incident on it
  or its accounts. Loss-limit and drawdown stops are not pauses and are unchanged.

## Consequences

- Design §12.4's "resolving an incident never resumes a strategy" still holds for people; the
  worker's automatic resume is a separate, audited path limited to the three passing causes.
- A strategy can resume into the same outage; the backoff and the daily cap bound how often.
- The gate is per worker process; with more than one worker each syncs an account at most once per
  interval.
