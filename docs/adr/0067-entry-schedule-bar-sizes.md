# ADR 0067: Entry schedule names its bar size

- **Status:** accepted
- **Date:** 2026-11-09
- **Design refs:** design v1.2 row N184, open point O135. Amends v1.2 item 4 (calendar scheduling)

## Context

The Entry section's "Evaluate Entry and re-selection" field offered "Every bar (daily)" next to
the calendar periods. "Every bar" meant every bar the run stepped on, so on a 5-minute back test
it checked Entry every 5 minutes despite saying "daily", and there was no way to choose between
checking every minute, every 5 minutes or once a day. Yong: "can you make sure there is an option
for every bar at 1 minute, and every bar at 5 minutes, and then daily? the current option
"every bar(daily)" is not only confusing but also not able to represent the different choices i
should have."

## Decision

- **Options.** Every 1-minute bar (`bar1m`), Every 5-minute bar (`bar5m`), Every hourly bar
  (`bar1h`), Once a day, after the close (`daily`), then the calendar periods as before (week,
  month, quarter, year end). The dropdown groups them as "Every bar" and "Once per period".
  Hourly is added so 1-hour back tests have a matching choice.
- **Bar cadences** check Entry once per bar slot of that size, keyed by the newest bar's end
  (`scheduledPeriod`): on bars of that size or coarser that is every bar; on finer bars it is
  the bar that ends on each slot boundary (plus the session's first bar).
- **Once a day** checks Entry once, at the first evaluation after a session's close: on daily
  bars every bar, as before; on 5-minute or hourly bars once a day instead of every bar.
- **Default.** A strategy that never picked a schedule takes the cadence of the finest bars its
  rules read (`defaultSchedule`): under 5 minutes every 1-minute bar, under an hour every
  5-minute bar, under a day every hourly bar, otherwise once a day. So a stored strategy whose
  back test bars match its conditions checks Entry exactly as before; the field shows that value
  with "Matches the bars your conditions read until you pick one". Picking stores the choice.
- **Rebalance semantics unchanged.** Only the calendar periods are "scheduled" rebalances
  (`isCalendarSchedule`): Selection exits of unselected holdings and the per-leg rebalance work as
  before; the bar cadences and once a day are continuous.
- **Back tests.** The Bars default (N179) treats a picked bar cadence as a condition on bars of
  that size, so "Every 5-minute bar" defaults to 5-minute bars. A run on bars coarser than the
  cadence warns (`schedule_finer_than_bars`) that Entry was checked once per run bar. Back tests
  have no 1-minute bars, so "Every 1-minute bar" runs on 5-minute bars with that warning.
- **Paper runtime** uses the same function with the newest condition bar's end, and now
  remembers the last evaluated period for every schedule, not only the calendar ones.

## Consequences

- Strategies whose rules read daily bars but were back tested on hourly or 5-minute bars now
  check Entry once a day instead of every run bar (corpus run #21 changes on purpose).
- No feed serves 1-minute bars yet (O135), so "Every 1-minute bar" checks as often as the finest
  bars that arrive: 5-minute bars on Alpaca. Adding 1-minute bars to the Alpaca feed and back
  tests is a separate change.
- No migration: stored definitions without a schedule keep working through the default; old
  back test results labelled "daily" show the new "Once a day" label.
