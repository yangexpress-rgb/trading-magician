# ADR 0111: FINRA short interest

- **Status:** accepted
- **Date:** 2026-11-23
- **Design refs:** design v1.3 §8.2 (metric registry), §16.4, §16.7; N323; O200 to O205. Yong's
  brief "Data inputs part 2" (2026-11-23), item B. Builds on ADR 0058 (event data and the optional
  credential pattern of the earnings calendar) and ADR 0091 (the pattern factor store).

## Context

The app had no short-side data. FINRA publishes consolidated short interest twice a month, free,
from December 2017, through its Query API (OAuth2 client credentials, scope `data.public.read`).
The point-in-time rule is normative: a row describes its settlement date but becomes public about
seven trading days later, and nothing may read it before then.

## Decision

- **Dataset.** `otcMarket/consolidatedShortInterest`. The brief named
  `equityShortInterestStandardized`, but that dataset (checked 2026-11-23) holds OTC issues only
  and starts 2019-07-15; the consolidated one holds exchange-listed and OTC issues from
  2017-12-29, with the same fields (O200).
- **Publication date.** FINRA's schedule: positions due the second business day after settlement,
  published five business days after that, so `available_date` = settlement + 7 NYSE trading days.
  The rule matches all 28 dates of FINRA's published 2026–2027 schedule (test fixture). The API
  carries no publication date. For a recent settlement first seen after its schedule date (FINRA
  late), the day it was seen is used instead. A revision keeps the first `available_date`.
- **Storage.** `short_interest` (instrument, settlement date, available date, FINRA's symbol, short
  shares, previous short shares, change, average daily volume, days to cover, revision flag,
  `source = 'finra'`, `recorded_at`), unique on (instrument, settlement date); published fields
  only, no percent of float. `short_interest_settlement` records each settlement read: available
  date, rows published and stored, and every symbol that matched no instrument (reported, never
  dropped silently). FINRA writes share classes without a dot (BRKB): symbols resolve exactly
  first, then with separators removed. A stored settlement that listed a symbol registered since is
  read again, so a new instrument gets its history (O202).
- **Job.** `SHORT_INTEREST_ENABLED` (default on) is the kill switch; without `FINRA_CLIENT_ID` and
  `FINRA_CLIENT_SECRET` the worker logs "short interest: not configured" once at boot and starts
  nothing. The credentials are plain optional strings, so a bad value can never fail the boot;
  FINRA refusing it is logged by each pass ("FINRA refused the API credential", never echoing it).
  Each pass reads FINRA's settlement list, stores the settlements not stored yet (newest first, six
  a pass, a minute apart while a backlog remains, else every six hours) and re-reads the most recent
  stored settlement once a day for revisions. When the backlog empties it logs the coverage report
  (B4). `pnpm --filter @tm/worker short-interest:backfill` does the whole backfill in one go and
  resumes where it stopped.
- **Metrics** (category `short`, an event metric): `short.shares`, `short.days_to_cover` (unknown
  when FINRA had no volume, its 999.99 sentinel, O204), `short.change_pct` (change ÷ previous, as
  published; unknown when the previous is 0 or missing). Each reads the latest row with
  `available_date` on or before the bar date, carried forward. A named stock read before its first
  publication fails a back test by name.
- **Pattern factors:** `short.days_to_cover` and `short.change_pct` in a new category "Short
  interest (FINRA)", cross-sectional and own-history atoms; carry-forward stated in the definition.

## Consequences

- B2 (AAPL against FINRA's own response on staging) waits for Yong's credential (O201).
- Snapshot rows stored before N323 do not get the short factors; scans see them from the first
  snapshot day after deploy (O205).
