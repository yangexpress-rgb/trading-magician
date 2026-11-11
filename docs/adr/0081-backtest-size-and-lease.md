# ADR 0081: Back tests sized up front, stale check once per step, simulation lease

- **Status:** accepted
- **Date:** 2026-11-11
- **Design refs:** design v1.2 row N232. Builds on ADR 0009 (back test queue), ADR 0063
  (5-minute back tests) and Design v1.2 item 1 (Selection groups)

## Context

Back tests of "Earnings breakout (test)" (S00009-SN, and Yong's S00018-SN) stayed in Running for
about 55 minutes and then failed with "The back test stopped responding and was abandoned". The
strategy trades the S&P 500 group, checks Entry daily, and its Enter-when rule reads 5-minute Last
and Low.

The diagnosis (2026-11-11, reproduced locally with the stage logging in
`apps/worker/src/backtest-trace.ts`) found:

- **Memory.** `planSeries` loads every condition series at its own interval for the whole window,
  so a daily run with a 5-minute condition loads a year of 5-minute bars for each of 502 members:
  about 10 million bars. Each bar is five `Decimal`s and two ISO strings, about 1.24 KB, so about
  12 GB against the worker's 2 GB heap. The worker crashed part way through loading, Railway
  restarted it, the run's lease lapsed, the next claim retried it from the start, and the third
  claim marked it abandoned. Nothing said why.
- **Simulation time.** Engine step 4 checked whether any rule series was stale once for every
  member, so each step cost members × series. On 502 members over a year of daily bars the
  simulation took 364 s, longer than the 120 s lease, and it can't renew while it runs.
- Event loading (about 40 ms) and saving the result (under 1 s) were not involved.

## Decision

- **Refuse runs too big for the worker, with the reason.** `estimateWorkload` turns a run's series
  plan into estimated bars per interval (trading days × bars per session). `workloadProblem`
  refuses a plan over `MAX_BACKTEST_BARS` (1.2 million) with a message naming the total and what
  drives it, for example "This back test needs about 10.4 million price bars, mostly 5-minute bars
  for 502 instruments over about 12 months. A back test can hold up to 1.2 million. Shorten the
  dates or test fewer stocks." `startBacktest` checks before queuing (a built-in group counts its
  full list), and the worker checks again after planning, before any bar request, so a run queued
  earlier fails at once with the same message.
- **The limit.** In the reproduction about 1.5 million loaded bars filled the 2 GB heap, while 502
  members with a month of 5-minute bars (about 1.1 million estimated) completed at 1.4 GB.
- **Stale check once per step.** Step 4 counts a stale step when any instrument has a bar and any
  rule series is stale. The series check doesn't depend on the instrument, so it now runs once per
  step. Results are unchanged (same cycles, same stored result); 502 members over a year of daily
  bars simulate in about 3 s instead of 364 s.
- **Simulation lease.** The lease is renewed for 10 minutes (`simulateLeaseSeconds`) just before
  the simulation, which can't renew while it runs, so no other worker can claim the run under it.
  The worker still renews every 40 s while loading. A worker that loses its lease can neither
  renew nor write (the existing owner check). The stage log warns when a renewal gap passes the
  lease.

## Consequences

- The exact failed configuration is refused in seconds with its reason instead of running for
  55 minutes. Shorter windows (502 members, about one month of 5-minute bars) and smaller groups
  still run.
- A worker that crashes during a simulation waits up to 10 minutes before the run is retried.
- Holding the full S&P 500 with 5-minute conditions over a year needs compact bar storage (numbers
  instead of `Decimal` objects, about 25 times less memory) or loading only the 5-minute bars each
  daily check reads. Both are left for a later change; raising `MAX_BACKTEST_BARS` then is one line.
- Lease length and attempt count are unchanged for loading: they were working as designed.
