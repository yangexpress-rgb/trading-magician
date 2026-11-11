# ADR 0082: Back test inputs follow the strategy

- **Status:** accepted
- **Date:** 2026-11-11
- **Design refs:** design v1.2 rows N233, N234, N235. Replaces the Bars choice of N178 and N179
  (ADR 0063); keeps their limits (O132)

## Context

Yong asked for three changes to "Run a back test" on 2026-11-11:

1. No Bars choice. Check Entry, Check Exit and the conditions (ADR 0073, ADR 0078) already say
   which bars the strategy reads, so asking again only invites a mismatch.
2. Pick an end date (today by default) and a period going back from it, instead of From and To.
3. For a strategy that trades a group, an option to test only some of its instruments, to make a
   run smaller when needed.

## Decision

- **Bars (N233).** The run's bar size is `matchingBacktestInterval(definition)`: 5-minute when any
  check or condition reads bars under an hour, hourly for hourly or 4-hour, daily otherwise. The
  form shows it in words. The server sets it from the saved rules on every request
  (`fitInputs` in `packages/db/src/backtests.ts`), whatever the request sends, and refuses a
  period longer than that size allows (5 years daily, 1 year hourly, 31 days of 5-minute bars).
- **Dates (N234).** The form has End date (today by default, no later than today) and Look back
  (1 or 2 weeks; 1, 3 or 6 months; 1, 2, 3 or 5 years; calendar months and years). Periods the
  strategy's bars can't cover are greyed out; the default is the longest up to a year that fits.
  Runs still store `from` and `to`, plus the period picked as `lookback`. Today's bars are still
  forming, so a run that ends today reads up to the previous day's close; the form says so, and
  the API turns `to` = today into yesterday. Earlier end dates are unchanged.
- **Instruments (N235).** For a group, "Instruments to test" offers the whole group (default) or
  only some of it, typed as symbols; a list group's members are also buttons to click. The run
  stores `symbols`. The server checks they are members (S&P 500 by its member list; a list group
  by its instruments) and only for a group. The worker narrows the members before loading bars
  (`pickMembers`), so the filter, ranking and Left the group read only those; a pick that has left
  the S&P 500 since is named in the run's warnings. The run summary names up to three picks or
  their count, and the assumptions list them.

## Consequences

- Older runs keep their stored inputs and read as before; `lookback` and `symbols` are optional.
- API clients that sent `interval` get the strategy's own; to test other bars, change the rules.
- No migration: the inputs are jsonb. The engine and paper runs are unchanged.
