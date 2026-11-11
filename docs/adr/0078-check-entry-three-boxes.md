# ADR 0078: Check Entry and Check Exit in three boxes

- **Status:** accepted
- **Date:** 2026-11-11
- **Design refs:** design v1.2 row N227. Supersedes ADR 0077 (after the open); extends N184 (bar
  sizes), ADR 0073 (Check Exit) and O144 (stop closes at the Check Exit bar size)

## Context

After the after-the-open check (ADR 0077) Yong could not find its box, which only appeared for
once-per-period choices. He asked for Check Entry to be restructured into three choices, so every
scenario of when a strategy runs can be named: which bar (every, before, 1st, 2nd, last), the bar
(1 minute, 5 minutes, 30 minutes, 1 hour, 1 day) and the day (every trading day, the last trading
day of each week, month, quarter or year). He chose "before" to mean before the open.

## Decision

- **Shape.** A schedule is `{ which, bar, days }`: which `every | first | second | last |
beforeOpen`, bar `1m | 5m | 30m | 1h | 1d`, days `daily | weekly | monthEnd | quarterEnd |
yearEnd`. It applies to Check Entry and Check Exit alike.
- **Saved schedules.** The schema still reads `{ frequency, at }` and turns it into the same checks
  (`scheduleFrom`): every 1-minute, 5-minute or hourly bar on every trading day; every 1-day bar on
  the period's days; the 1st 1-minute, 5-minute or hourly bar for a check after the open. Stored
  versions are not rewritten, so hashes stay; no schema version change or migration. All recorded
  corpus back tests run unchanged.
- **Meaning.**
  - Every intraday bar: as each bar of that size closes, only on the chosen days.
  - 1st / 2nd: on each chosen day once the bar ending one or two bars after the open is in.
  - Last, or any choice on 1-day bars: once after the close of each chosen day.
  - Before the open: on each chosen day, one bar (at most an hour) before the open in paper runs,
    reading the bars already in, so orders go in at the open. Back tests step only on regular-
    session bar ends, so they check at the prior session's close: the same data and the same
    fill at the open.
- **Back tests.** The default Bars follows the bar a check needs (5-minute for 1st 5-minute or
  every 30-minute, hourly for the 2nd 30-minute or 1st hour). A coarser run warns. Results log
  the schedule in words ("1st 5-minute bar, last trading day of each month"); older runs' codes
  are shown in words too.
- **Stops** read 5-minute closes for 1-, 5- and 30-minute Check Exit bars (no 1- or 30-minute
  feed), hourly for hourly, daily otherwise.
- **Builder.** Three boxes: Check Entry (which), Entry bar size, Entry days; the same for Exit,
  whose first box also offers "Every bar the run steps on" (no Check Exit). On 1-day bars only
  Every and Before the open are offered. A line under the boxes says the schedule in words.

## Consequences

- No feed serves 1-minute or 30-minute bars yet (O135); conditions on those bars have no data,
  though checks at those times work on 5-minute bars.
