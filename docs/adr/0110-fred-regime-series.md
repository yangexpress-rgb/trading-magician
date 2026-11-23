# ADR 0110: FRED market-regime series

- **Status:** accepted
- **Date:** 2026-11-23
- **Design refs:** design v1.3 §8.2 (metric registry), §16.4, §16.7; N322; O197 to O199. Yong's
  brief "Data inputs part 2" (2026-11-23), item A. Builds on ADR 0058 (rates from FRED's DTB3) and
  ADR 0091 (the pattern factor store).

## Context

The worker fetched one FRED series, DTB3, into `rates_daily.tbill_3m`. Item A adds five
market-regime series usable as strategy metrics and as pattern-discovery factors: the ICE BofA
investment-grade and high-yield option-adjusted spreads (BAMLC0A0CM, BAMLH0A0HYM2), the 10-year
minus 2-year Treasury spread (T10Y2Y) and the 10- and 2-year yields (DGS10, DGS2). Existing
readings, above all `rates.tbill_3m`, must not change.

## Decision

- **Storage.** `rates_daily` stays one wide row per date with `source = 'fred'` and
  `recorded_at`; it gains one nullable numeric column per series (`credit_spread_ig`,
  `credit_spread_hy`, `term_spread_10y2y`, `ust_10y`, `ust_2y`), values as fractions (percentage
  points ÷ 100, computed in decimal so 4.98 is stored as 0.0498). `tbill_3m` becomes nullable,
  since a day can now hold another series' value only. DTB3 is still stored from 2024-02-01 by the
  options inputs, exactly as before; T-bill reads skip rows without a T-bill value, so its readings
  are identical (A1, checked against readings captured from the build before this change).
- **Fetching.** Same keyless route as DTB3 (`fredgraph.csv?id=…`, `FRED_CSV_URL`), one request per
  series, from the events loop: asked every pass, it fetches when its last fetch is older than six
  hours (so a deploy fills the history at once; a failed series retries after 30 minutes). Each
  series is kept from 2016-01-01 or its first published day, whichever is later; a revised value
  replaces the stored one (latest vintage only, O197's neighbour: ALFRED is out of scope). After
  each fetch the job logs the coverage report: per series (DTB3 included) first and last day, day
  count, and NYSE trading days inside the range without a value, bond-market holidays (Columbus
  Day, Veterans Day) counted apart.
- **Metrics.** `rates.credit_spread_ig`, `rates.credit_spread_hy`, `rates.term_spread_10y2y`,
  `rates.ust_10y`, `rates.ust_2y` through the existing event-metric mechanism (category `rates`,
  unit fraction), each the latest value dated on or before the bar date (the rates convention).
  Help text says "values as currently published by FRED". A back test that ends before a series'
  first stored day fails with "No <series> data before <date>", as the T-bill does.
- **Pattern factors.** IG spread, HY spread, term spread and 10-year yield join the catalogue as
  market-level factors (`marketLevel`), own-history atoms only (the same value for every stock on a
  date), like the T-bill. New snapshot rows compute them through the registry.
- **Market-level fill.** Rows stored before these factors existed would otherwise never get them
  (the store is insert-only). The pattern loop adds them, a few dates a pass: per date, the value
  the registry would read, merged as `new || values` so a key already stored always wins, with the
  coverage counts raised in the same transaction. The worker gains `UPDATE ("values")` on
  `factor_snapshot` for this alone (migration 0107, O199).

## Consequences

- FRED publishes the ICE BofA spreads for the last three years only (an ICE licence limit):
  through this route they start 2023-11-21, not 2016. The store never deletes a day, so history
  grows from here. A4 was checked inside the window (`credit_spread_hy > 0.04` over 2025), as Yong
  chose on 2026-11-23 (O198).
- Same-day reads follow the brief's rates convention; FRED publishes these values the next
  business day, so a daily-close bar sees a value a day before it was public (O197).
