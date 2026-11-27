# ADR 0121: Handing research over to the Local Companion

- **Status:** accepted
- **Date:** 2026-11-26
- **Design refs:** design v1.3 §17.4; N346 to N348; O218; migration 0116. S2 plan step 4.
  Builds on ADR 0117 to 0120.

## Context

After step 3 the companion can do every research job the cloud does: train the ML models, write
the ML feature snapshots and the pattern factor store, and mine queued scans. The cloud still runs
its own copies of those jobs, and it still scores decay on Verified patterns (`run_decay`). Two
producers of the same outputs must not run at once. A scan the companion claimed would also stay
`running` forever if the companion never came back.

## Decision

- **One switch, `RESEARCH_MODE=companion`, on all three services** (N346). The web app already
  reads it for the paused message (ADR 0116). The worker now reads it too: it stops the ML snapshot
  and pattern snapshot loops. The trainer service reads it and does nothing, so neither ML training
  nor the miner (scans and decay) runs in the cloud. The default stays `cloud`, which is as before.
  Answering the companion's data requests, applying its pushes, and everything Core reads (events,
  options signals, prices) keep running in the cloud whatever the mode.
- **Decay is scored on the companion** (N347). Each mining pass asks `pattern_decay_due`. The worker
  answers with the cloud's Verified patterns of finished scans that are due by the miner's own rule:
  not scored for 7 days, or a re-verify asked for. Each answer carries the pattern and the scan
  fields the decay job reads. The companion copies them into its local store, where a newer local
  score is kept, and runs the miner unchanged. It then pushes each new score as `pattern_decay`:
  - The push carries the fresh occurrences from 90 days before the cloud's last score. An occurrence
    dated earlier only becomes known once its horizon has passed, and the cloud keeps any it
    already has.
  - Large pushes go in parts of 20,000 occurrences. The state comes with the last part, so the cloud
    never shows a score ahead of its evidence.
  - The cloud never lets an older score replace a newer one.
  - A re-verify asked for in the cloud after the companion read the pattern stays asked for.
- **Stalled scans go back in the queue** (N348, O218). With research on the companion, the worker
  puts a scan left `running` for 48 hours back to `queued`. 48 hours is the same span after which
  the companion counts as offline (ADR 0116). The companion's result is still taken if it arrives
  later. If the companion claims again a scan it had already finished, it sends that result again
  under a new key.
- **A4, the 48-hour offline test**, is automated. With the companion silent for 48 hours, research
  pages say paused. The scores that trading reads are the last ones delivered, unchanged. The scan
  it held is released. A live run of the same test on the producer's computer comes with step 5.

## Consequences

The switch is a staging setting, flipped only on Yong's go-ahead. It should go together with step
5's data move. Until that move, the cloud's own feature and factor history and its patterns are not
in the local store. Decay works before the move, because the due patterns are pulled. The ML and
factor jobs start their local history at the cloud's served dates (ADR 0118). Turning the switch
back to `cloud` resumes the cloud jobs where the cloud's data stands.

## Amendment (2026-11-27, N351)

The decay job takes its day in UTC. On Yong's Mac (New York time) the companion asked the cloud
for patterns due on the UTC day, but the miner used the local date. From 7 PM each evening the
two disagreed, and the 200 due patterns were pulled but never scored. Railway runs in UTC, so
nothing changes for the cloud.
