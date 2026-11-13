# ADR 0052: Options recording yields within an Alpaca key's request budget

- **Status:** accepted
- **Date:** 2026-11-08
- **Design refs:** §12, §17.3; design v1.2 row N96, open point O70. Follows ADR 0050 (the
  recording uses the admin's Alpaca feed key)

## Context

Since ADR 0050 the options recording can sign with the same Alpaca paper key as the admin's own
strategies and screens. Alpaca's free plan allows 200 requests a minute per key. Right after a worker
restart on Yong's Mac, the recording made its start-up requests: closes for each recorded chain and
the IV history rebuild (option contracts and bars over 275 days). A paper strategy's back-test data
load then got HTTP 429 ("Alpaca is over its request limit for this key") and failed.

## Decision

- **One budget per key in the worker process.** Every `AlpacaClient` counts its requests in a shared
  per-key window of the last minute (`packages/alpaca/src/budget.ts`).
- **Strategies, screens, charts and searches are never delayed by it.** Their requests go at once,
  as before.
- **The options recording is background work.** Its client (closes and the history rebuild) waits
  before each request until:
  - it has sent fewer than 60 requests in the last minute; and
  - the key as a whole has sent fewer than 120 in the last minute, keeping 80 of the 200 for
    everything else; and
  - any 429 on that key has passed: the time Alpaca gives, or a minute.
- The recording's calls already retry on 429, so a slower rebuild finishes later rather than failing.
- The local fake Alpaca used by tests and e2e has no limit, so the fake recording is not paced.

## Consequences

- After a restart, the history rebuild takes longer: at most 60 requests a minute.
- The budget is per worker process. Two workers on one key, or the web app's own Alpaca calls
  (search, feed checks), are not counted against each other. That is fine for one worker today and
  is open point O70.

## Amendment (2026-11-13): a background floor

Running strategies (paper runtimes, foreground) can keep a key above the 120 requests a minute
that background work may share, for as long as they run. A 5-minute back test asks for its bars
as background work, so on staging it waited in `load_bars` without making a single call until a
redeploy restarted the worker. Now up to 10 background requests a minute (`backgroundFloor`,
never more than the background share) go while the key is still under Alpaca's 200, even inside
the reserve. Foreground requests can lose at most those 10 of their 80 reserved.
