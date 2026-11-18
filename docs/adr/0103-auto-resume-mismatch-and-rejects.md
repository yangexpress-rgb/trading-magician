# ADR 0103: Mismatch and repeated-rejects pauses resume on their own

- **Status:** accepted
- **Date:** 2026-11-18
- **Design refs:** design v1.3 §12.4; N301. Amends ADR 0014, ADR 0097 and ADR 0102. Requested by
  Yong on 2026-11-18: "we need to build a mechanism to auto resume this type of paused
  strategies", after S00038 (reconciliation mismatch) and S00039 and S00033 (repeated rejects)
  paused on staging on 2026-11-17.

## Context

ADR 0097 let pauses for passing outages (broker silence, throttling, lost prices) lift themselves,
but kept reconciliation mismatches and repeated rejects waiting for a person. On a paper account
that a person checks once a day, that left strategies idle for a day or more over causes that had
already passed, or that a retry the next morning would get past.

## Decision

- **Taking the pause on.** A paused runtime with no automatic pause recorded looks up, once per
  pause reason, the incident that gave it that reason (`pauseIncident`): a reconciliation mismatch
  on the runtime or its accounts, or the runtime's repeated rejects. A pause no such incident
  explains (a person's, the kill switch's, a plan change) is left alone, as before.
- **Mismatch.** A reconciliation that comes back clean resolves its account's open mismatch
  incidents (`resolveAccountIncidents`, "Reconciliation came back clean"). Once none is open on
  the runtime or its accounts and the broker answers, the strategy resumes the ADR 0097 way: after
  1, 3 then 10 minutes, healthy for 30 s, at most 3 automatic resumes per New York day shared with
  the outage kinds. A mismatch that comes back pauses it again.
- **Repeated rejects.** The strategy retries at the next regular session's open after the pause
  (`nextOpenAfter`), while that session is open, unless a mismatch is open on its accounts. Each
  retry resolves its repeated-rejects incident and counts in `rejectRetries`. After 2 retries in a
  row with no order of the strategy filling in between (`REJECT_RETRIES`), it stays paused and says
  so once. An order that fills since the last resume starts the count again.
- **Told each time.** Each automatic resume is audited (`runtime.resumed`, `auto: true`, with its
  cause) and notified "… resumed on its own" with what happened; the give-up is notified once.
- **Always.** The kill switch still blocks every resume; a person can Resume at any time.

## Consequences

- A paused strategy such as S00033 (refused by Alpaca because another strategy on the same account
  holds the opposite position) retries at the next two opens, then stays paused until a person
  fixes the cause. At most 2 days of 3 refused orders each.
- A strategy paused before this change is taken on at its next pass after the deploy.
- Design §12.4's "resolving an incident never resumes a strategy" still holds for a person's
  Mark resolved; the worker's resume is its own audited path.
