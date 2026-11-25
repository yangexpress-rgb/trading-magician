# ADR 0119: The pattern factor store on the Local Companion

- **Status:** accepted
- **Date:** 2026-11-25
- **Design refs:** design v1.3 §17.4; N344; migration 0115. S2 plan step 3c, first part (3c-i).
  Builds on ADR 0118.

## Context

Pattern mining (3c-ii) reads the factor store, `factor_snapshot` (ADR 0091), which is most of the
Research Store's size. Its writer reads what the ML feature writer reads, plus every events metric
(deals, rates, the FRED series, short interest), the daily options signals, and 5-minute bars for
the options universe's session factors. Its members are the snapshot groups' members today,
everyone who was an S&P 500 member since the store's first day (N324), and the options universe.

## Decision

- **One job, two places.** `apps/worker/src/patterns/snapshots.ts` moves to `@tm/db`
  (`pattern-snapshot-job.ts`; the worker re-exports it), with optional `refs`, `events` and
  `optionSignals` ports that the worker does not pass, as ADR 0118 did for the ML job.
- **Two more request kinds** (migration 0115 widens the check): `pattern_members` answers the
  members, the options universe and the store's first day (`PATTERN_SNAPSHOT_FROM`) as the
  worker's own loop resolves them; `option_signals` answers `loadOptionSignals`. `events` takes an
  optional list of metrics and now carries every part of the events data. 5-minute bars come
  through `bars` like daily ones.
- **Same rows.** A worker test runs the job both ways over the same inputs, the companion's way
  with every answer crossing as JSON, and the factor rows come out identical.
- **On the companion.** A `factors` job (every 10 minutes, one batch of 10 members a pass) writes
  `factor_snapshot` and `factor_coverage` locally. Producer only, as O217 proposes.

## Consequences

The cloud's factor store loop keeps running until the hand-over (step 4). A companion that starts
from an empty store backfills from `PATTERN_SNAPSHOT_FROM`, one batch at a time, through the
admin's feeds on the background budget; Yong's data move (step 5) copies the cloud's rows instead.
