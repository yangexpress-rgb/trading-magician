# ADR 0007: Historical data and indicators

- **Status:** accepted
- **Date:** 2026-10-04
- **Design refs:** §7.1, §7.2, §12.1, §18 Phase 2, §20 #1, §20 #5

## Context

Back tests need historical bars for several instruments, aligned in time, with corporate-action adjustment and a record of exactly which data a run used. No market-data provider has been chosen yet (§20 #1), and seed data must stay generic (§21).

## Decision

**Provider interface.** `HistoricalDataProvider` in `@tm/domain` returns a `BarSeries` for one instrument, interval, date range, adjustment policy and session. The series carries a `dataVersion` for provenance and plain-language `warnings`. Bars are decimals with explicit UTC `start` and `end`, and a bar may be used only once its `end` has passed. That is the rule the engine uses to prevent lookahead.

**Demo history.** `@tm/market-data` generates prices for the DEMO instruments from a factor model. Pairs in the same sector are strongly correlated, which makes pairs strategies meaningful.

- Every value is seeded from the symbol and date, so a request returns identical bars whatever range it asks for.
- The history includes a 2-for-1 split (DEMO-C, 2021-06-14), regular cash dividends (DEMO-E, DEMO-IDX, DEMO-BND), early closes, and about 0.3% of hourly bars left out, so missing-bar handling is exercised.
- It has daily and hourly bars, regular session only, from 2015-01-02, never past the current time.
- Adjusted prices are as of today, like a real feed, so their `dataVersion` names that date.

**Calendar.** The NYSE calendar is rule-based: the holidays with weekend observance, the 1 p.m. early closes, and the announced special closures. It needs no data file.

**Indicators.** Every catalog indicator has a pure implementation over bars. Values depend only on bars up to their index, and a property test enforces this. EMA is seeded with an SMA. RSI and ATR use Wilder smoothing. Bollinger bands use the population standard deviation. RSI is 50 when prices did not move.

**Quote fields.** Bars carry no quotes. In a back test, `last`, `bid`, `ask` and `mid` read the close, and `vwap` reads the typical price. Results list this substitution as an assumption.

## Consequences

- A real provider plugs in behind the same interface. Its `dataVersion` must change whenever the data it returns could change.
- Generated history is for exercising the product, not for judging strategies. The results screen says so.
