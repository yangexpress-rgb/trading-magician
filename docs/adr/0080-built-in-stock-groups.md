# ADR 0080: Built-in stock groups beyond the S&P 500

- **Status:** accepted
- **Date:** 2026-11-11
- **Design refs:** design v1.2 row N231. Extends ADR 0030 (the screener's S&P 500 list), Design
  v1.2 item 1 (Selection groups over a built-in universe) and ADR 0073 (What to trade)

## Context

The screener's "Stock group" offered the S&P 500 and All US stocks, and a strategy group's
built-in universe was the S&P 500 only. Yong asked for the Nasdaq 100 and other groups, and chose
all of: Nasdaq 100, Dow 30, the eleven S&P 500 sectors, S&P MidCap 400, S&P SmallCap 600, Russell
1000 and Russell 2000. Alpaca does not say which index a stock is in.

## Decision

- **One registry.** `packages/domain/src/market/stock-groups.ts` lists every group (`STOCK_GROUP_IDS`,
  `STOCK_GROUPS`) with its label, source, as-of day and members. The strategy schema's
  `BUILTIN_UNIVERSES` is that list, so the builder, the screener, back tests and the worker all
  read the same groups. Sector groups are the S&P 500 list split by its GICS sector, so they need no
  list of their own.
- **Lists ship with the app,** as the S&P 500 list did. `pnpm --filter @tm/domain groups:update`
  rewrites `src/market/groups/<id>-members.ts` from public sources: Wikipedia's member tables for
  the Nasdaq 100 (Nasdaq's own published list when the table can't be read), the Dow 30 and the S&P
  400 and 600; iShares' IWB and IWM holdings for the Russell 1000 and 2000, because FTSE Russell's
  lists are not public. iShares does not hand its files to scripts, so a holdings CSV saved from
  the fund page is loaded with `--file r2000=IWM_holdings.csv`. Each file names its source.
- **Monthly refresh.** The "Refresh stock groups" GitHub workflow runs both update commands on the
  2nd of each month (or by hand) and opens a pull request with any member changes. A source that
  fails leaves its list as it was.
- **Groups without a list are hidden.** A group whose list has never been loaded (the Russell
  groups until their holdings files are loaded) is left out of the pickers; its id stays valid.
- **Screener.** `stock_screen.universe` takes any group id (migration 0084 replaces the
  `IN ('sp500', 'all')` check with a format check). The worker screens just the group's members.
  Rows already loaded for the whole market, or for the S&P 500 when a sector is picked, are
  reused without a new load. Sectors come from the S&P 500/400/600 lists first, then the Nasdaq 100
  and the Russell holdings; the company panel names the index groups a stock is in.
- **Back tests** resolve the chosen group (`resolveBuiltinUniverse({ group })`); warnings and
  validation messages name it. Every group is today's member list, so back tests over past years
  carry survivorship bias, as before. Built-in groups still back test only; paper runs take lists
  of up to 50 instruments.

- **Earnings releases for every group member.** The earnings scan (ADR 0058) covers every
  member of the built-in index groups plus stocks saved strategies use, not just the S&P 500. A
  daily backfill (`earnings_backfill`, after the one-off rebuild) reads the history back to
  February 2024 for any stock in that universe with no release older than 120 days: a new group's
  members, or a strategy's new stock. Migration 0084 adds the job to `event_scan_state`.

## Consequences

- New groups are a list file plus a registry entry, with no migration.
- The web bundle carries every list (a few thousand symbols).
