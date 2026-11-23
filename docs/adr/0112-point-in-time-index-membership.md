# ADR 0112: Point-in-time S&P 500 membership

- **Status:** accepted
- **Date:** 2026-11-23
- **Design refs:** design v1.3 §8.2 (built-in groups), §16.4; N324; O206 to O209. Yong's brief
  "Data inputs part 2" (2026-11-23), item C. Builds on ADR 0080 (built-in stock groups) and
  ADR 0091 (the pattern factor store).

## Context

Back tests of the S&P 500 group used today's members for every past day, so a 2019 test could buy
Tesla a year before it joined and never held Silicon Valley Bank, which failed in 2023
(survivorship and look-ahead bias). fja05680/sp500 publishes the index's full member list as of
every change since 1996 ("S&P 500 Historical Components & Changes (Updated).csv").

## Decision

- **A local file, never fetched by the app.** A person downloads the CSV and runs
  `pnpm --filter @tm/domain groups:history --file <csv>`, as `groups:update --file` does for the
  Russell lists. The script turns the snapshots into one period per stretch a symbol was a member
  (`[from, to)`, `to` null while still one) and writes
  `packages/domain/src/market/groups/sp500-history.ts` with the file's SHA-256 and last date.
  `groups:update`, `sp500:update` and the `*-members.ts` lists stay.
- **Table.** `group_membership_period` (migration 0109): `group_id` ('sp500'), `symbol`,
  `instrument_id` (nullable), `from_date`, `to_date`, `source` ('fja05680-sp500'), `recorded_at`.
  The worker stores the periods when it starts and once a day (`GROUP_MEMBERSHIP_SYNC`, default on):
  new periods inserted, changed ones updated with a new `recorded_at`, periods the file dropped
  deleted. A second run of the same file changes nothing (C3).
- **Resolution follows the company.** A period resolves through the symbol its company trades
  under now: `SYMBOL_RENAMES` lists the ticker changes, each checked by a test to be a same-day
  swap in the file (FB to META on 2022-06-09; FISV to FI to FISV). Mergers that made a new company
  (MYL to VTRS, WRK to SW, PARA to PSKY) are not renames. Symbols another company used before (old
  DuPont `DD` and Dow Chemical `DOW`, before 2017) never resolve to today's holder. The sharing
  admin's US stock feed confirms and registers symbols, as built-in groups always have.
- **Never dropped.** A period that ended before the price feed's history (2016-01-04,
  `PATTERN_SNAPSHOT_FROM`) has no bars and is stored without an instrument; so is a period whose
  symbol no feed lists (most were delisted). The worker logs a report each run: periods stored,
  inserted, updated, deleted, the unresolved count with every symbol, and by year the members,
  the unresolved ones and the resolved ones the factor store holds no bars for (C5).
- **Who reads members as of a day.** Back tests of the S&P 500 group resolve to everyone who was a
  member at some point in the run, with their spans, and each selection ranks only that day's
  members (`memberSpans` in the engine). The pattern factor store snapshots every member since its
  first day, and an S&P 500 scan stores each member's spans in its config (`memberPeriods`); the
  miner counts a day only while the stock was a member and ranks cross-sections over that day's
  members. `membersAsOf(groupId, date)` answers the question directly.
- **Who keeps today's list (v1).** The screener, paper and live runs, the S&P 500 sector groups,
  the other indices and the ML trainer (O206). The group picker says so.

## Consequences

- Back tests and pattern scans of the S&P 500 lose the look-ahead of later additions, and gain
  former members the feed still lists. Former members no feed lists are still missing, so some
  survivorship bias remains; the run's warnings name how many (O208).
- The file ends on its last change date (2026-08-18 at import); later changes appear when it is
  imported again (O207).
- The factor store backfills former members, about a third more instruments (O209).
