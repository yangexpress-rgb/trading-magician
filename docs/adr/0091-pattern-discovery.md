# ADR 0091: Pattern discovery: excursion outcomes, a holdout + FDR gate, and its own factor store

- **Status:** accepted
- **Date:** 2026-11-13
- **Design refs:** design v1.2 N261 onwards, O158–O163. Pattern discovery brief
  (2026-11-13), requested by Yong.

## Context

Research gains pattern discovery: the app searches conjunctions of point-in-time factors
("atoms") for combinations that were followed, unusually often, by a defined price move, and
shows each surviving rule with out-of-sample evidence. Three judgement calls shape everything
else, and the brief asks for them to be recorded.

## Decision

1. **Excursion outcomes.** An occurrence's outcome is whether the price reached +X% (spike) or
   −X% (plunge) at any point in the next H trading days, measured from the occurrence day's
   close with daily highs and lows, not the plain forward return at H. A trader acts on a move
   while it happens; the plain return, the realised run-up and the drawdown are still recorded
   per occurrence for the evidence page. An occurrence counts in a window only when its whole
   horizon lies inside that window, which is also the embargo between discovery and holdout.
2. **A discovery/holdout split with a false-discovery gate.** The search sees only the first
   70% of the scan range. Finalists are tested once on the last 30%, and a pattern is
   Verified only when its holdout hit rate's Wilson lower bound beats the holdout base rate,
   lift is at least 1.25, holdout n is at least 15, and its one-sided binomial p-value survives
   Benjamini–Hochberg at q = 0.10 across the scan's finalists. Everywhere but the detail page,
   the probability shown is the holdout one. Mass testing is the method, so the number of rules
   tried is shown beside every pattern, and a scan that verifies nothing is a valid result.
3. **A separate factor store.** `factor_snapshot` holds raw values for every registry factor,
   every trading day, for every member of the snapshot universes. `ml_feature_snapshot` is
   scoped to one model, stores cross-sectional z-scores and is monthly; overloading it would tie
   patterns to a model's feature set and calendar. The two share the principle (point in time,
   computed through the back test's own market view, frozen once written), not the table.

Supporting choices:

- Rows are insert-only (the worker login has `SELECT, INSERT` only), and computed as of the
  day's close through `MarketView`, so a row can only use what was known then. The worker
  integration test changes every input dated after a day T and checks rows up to T are
  identical.
- The miner cannot read bars (no bar store, O152), so each row also stores that day's bar as
  ratios to the previous adjusted close (O160). Ratios survive later adjustments unchanged.
- `factor_coverage` keeps known values per factor and day as rows are written, in the same
  transaction, so the coverage report and each scan's effective range per category never
  count millions of rows.
- Fundamentals gain `ocf_ttm` and `capex_ttm` (cash-flow statement, year-to-date chains) for
  the FCF margin; companies pick them up at their next daily sync.

## Consequences

- Storage grows by about one row per member per trading day (roughly 1,500 members); the
  coverage report shows the table's size on disk.
- Scans are bounded by recorded data: options signals from their recording or rebuild start,
  session factors only for the options universe (O158), fundamentals and prices further back.
- Universes are today's members, so survivorship bias applies; the pattern pages say so.

## Addendum: the miner, the pages, promotion and decay (N266–N270)

- The miner lives in the batch service (`apps/ml-trainer/miner/`) behind `PATTERN_MINER_ENABLED`.
  The web app writes the queued `pattern_scan` row itself, with the universe members and the
  catalogue resolved then (O170), and the miner claims it with `for update skip locked`.
- Patterns and occurrences are written once, in the scan's transaction. A trigger refuses any
  change to a pattern's rule, stats, status, scan, owner or rank; decay monitoring and
  Re-verify write only `decay_state`, `decay_stats` and `last_scored`, and add occurrences in
  the `fresh` window (O172).
- The binomial p-value treats occurrences as independent, which overlapping horizons and
  correlated stocks make optimistic (O171); the pages say so.
- Promotion reuses the Theory Library's own registration (T, daily, stocks), so numbering,
  sharing and editing need nothing new, and creates no Lab strategy (O159).
