# ADR 0120: Pattern mining on the Local Companion

- **Status:** accepted
- **Date:** 2026-11-25
- **Design refs:** design v1.3 §17.4; N345; migration 0115. S2 plan step 3c, second part (3c-ii).
  Builds on ADR 0117 (the inbox), 0118 (data requests) and 0119 (the factor store).

## Context

Pattern scans are queued by people in the cloud (Research › Patterns) and read there: the scan, its
patterns and their occurrences. The miner (`apps/ml-trainer/miner`) claims a queued scan, reads the
factor store and writes the results. With the factor store on the companion, the miner has to run
there, while the queue and the pages stay in the cloud.

## Decision

- **Claim through a data request.** The companion asks `pattern_scan`; the worker claims the
  oldest queued scan in the cloud's Research Store exactly as the cloud's miner does (`running`,
  `for update skip locked`, so the two never take the same scan) and answers its id, owner, config
  and summary.
- **Run the miner unchanged.** The companion copies the scan into its local store as queued and
  runs `python -m trainer` with only `PATTERN_MINER_ENABLED=on`; the miner claims it locally and
  writes the patterns and occurrences beside the local factor store.
- **Push the result.** A new push kind, `pattern_scan_result`, carries the scan's outcome and its
  finalists with their discovery and holdout occurrences (live "fresh" ones stay local). The worker
  writes it into the cloud's Research Store only while that scan is still `running`, with the
  patterns and occurrences owned by whoever queued the scan; a repeat is skipped. Pattern ids are
  kept, so later pushes can point at them.
- **Restarts.** A scan the local miner was running when the companion stopped is run again at the
  next pass, and anything finished but not sent is sent first.
- **Producer only** (O217): the producer's companion mines every person's queued scans.

## Consequences

Scans run where the factor store is. Decay scoring of verified patterns (`run_decay`) still runs
in the cloud until the hand-over (step 4); locally it only scores the companion's own copies,
which are not sent. A scan claimed by a companion that never comes back stays `running`; the
hand-over step adds a way to release it.
