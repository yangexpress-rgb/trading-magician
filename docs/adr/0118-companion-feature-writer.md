# ADR 0118: The ML feature writer on the Local Companion, with data asked of the cloud

- **Status:** accepted
- **Date:** 2026-11-25
- **Design refs:** design v1.3 §17.4; N342, N343; O217; migration 0114. S2 plan step 3, second part
  (3b). Yong merged 3a (#241) on 2026-11-25; S2 plan question 2 ("bars come through the cloud")
  was his pick on 2026-11-25.

## Context

3a runs the ML trainer on the companion, but the trainer learns from feature snapshots and labels
that the cloud's snapshot job (ADR 0086) writes into the Research Store. For the Research Store to
live on the companion, that writer has to run there too. It reads a model universe's members, their
instruments, daily bars (through the person's price feed, or the sharing admin's, N237), point-in-
time filings (through the company data feed) and earnings (the events store). None of that is on
the companion, and the S2 plan keeps it in the cloud: bars come through the cloud's feeds, and the
reference data stays in Core.

## Decision

- **One snapshot job, two places.** The job moves from `apps/worker/src/ml/snapshots.ts` to
  `@tm/db` (`ml-snapshot-job.ts`; the worker re-exports it), unchanged except for optional ports:
  `refs` (instruments) and `events` (earnings) are read from Core unless given, and `prefetchBars`
  asks for a batch's bars in one `getBarsMany` call before the back test's loader reads them. The
  worker passes none of them, so the cloud job is as before.
- **Data requests, answered by the worker.** The companion asks with
  `POST /api/companion/v1/fetches` (`members`, `bars`, `filings`, `events`; at most 200 items, at
  most 4 open at once) and polls `GET …/fetches/<id>`. The web app checks the request and queues it
  in `companion_fetch` (migration 0114) as the person; the worker answers every 3 seconds with the
  functions the cloud's job calls (`resolveBuiltinUniverse` through the sharing admin, the person's
  `createMemberHistory` on the background budget, the filings loader, `loadEventData`) and stores
  the answer as JSON (prices as decimal strings). An answer is handed over once and deleted;
  anything left after an hour is cleared. A request whose pairing has ended is refused.
- **Same rows.** A worker test runs the job both ways over the same inputs, the companion's way
  with every answer crossing as JSON, and the snapshots, labels and availability report come out
  byte-identical.
- **On the companion.** A `features` job (every 10 minutes, one chunk of dates a pass, like the
  cloud loop) mirrors the registry, then runs the job against the local store: snapshots, labels
  and the availability report are written there. A date the cloud has served is frozen in the
  mirror, so the companion never writes it; those dates arrive with Yong's data move (step 5). The
  local availability report wins over the cloud's once the companion has made one.
- **Producer only for now (O217).** Only the research producer's companion (O216) may ask, so one
  companion's backfill is the most the admin's feeds carry for this. Other companions skip the job.

## Consequences

Core gains one small queue table; nothing in it is kept. The cloud's snapshot job keeps running
until the hand-over (step 4); until then both stores get the same rows. The pattern factor store
(ADR 0091) still writes in the cloud; it moves with pattern mining in 3c.
