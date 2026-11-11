# ADR 0077: Check Entry and Check Exit after the open

- **Status:** superseded by ADR 0078 (the same checks, as "1st bar" in three boxes)
- **Date:** 2026-11-11
- **Design refs:** design v1.2 row N226. Extends N184 (Check Entry bar sizes) and ADR 0073 (Check
  Exit)

## Context

Check Entry's once-per-period choices (once a day, and the last trading day of each week, month,
quarter or year) were always checked after the NYSE close, so a strategy decided at the close and
traded at the next open. On 11 November 2026 Yong asked for these to also be checkable "after the
open", choosing the first 1-minute, 5-minute or hourly bar of the session.

## Decision

- **`schedule.at`.** A schedule may carry `at`: `close` (the default, stored as no `at`, so saved
  strategies are unchanged), `open1m`, `open5m` or `open1h`. It applies to Check Entry and Check
  Exit alike, and only to once-per-period frequencies; every-bar choices ignore it. No schema
  version change or migration: the field is optional.
- **When it is due.** On the period's trading day (any trading day for once a day; the last one of
  the week, month, quarter or year otherwise), at the first evaluation whose newest bar ends at
  least 1, 5 or 60 minutes after that day's open. Each period is checked once. Its period key
  differs from the after-the-close key, so switching between them checks once more.
- **Back tests** step on run bar ends, so the check falls on the first run bar ending at or after
  that time. The run Bars default asks for bars that fine (5-minute for the first 1-minute or
  5-minute bar, hourly for the first hour); a coarser run warns that the check fell at the end of
  the day's first run bar. Daily runs check at the close.
- **Paper runs** check once the bar is in when the rules read intraday bars. When they read only
  daily bars, the newest bar is yesterday's close all day, so the clock decides instead.
- **Labels.** "Once a day, after the first 5-minute bar"; "Last trading day of each month, after
  the first hour". Back test results show them beside Check Entry and Check Exit.

## Consequences

- There is still no 1-minute feed (O135): a 1-minute check runs on 5-minute bars in back tests.
- Picking the first 1-minute or 5-minute bar makes the default back test 5-minute, capped at 31
  days (O132); pick hourly or daily Bars for longer runs.
