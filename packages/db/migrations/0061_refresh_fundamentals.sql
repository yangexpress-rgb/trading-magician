-- v1.2 review (2026-11-07, ADR 0043): per-share figures were rescaled when a
-- filing's "dividends paid" differed from an earlier "dividends declared" for
-- the same quarter by a whole ratio, which was taken for a stock split. That
-- inflated dividends per share (screener yields above 100%) and could skew
-- EPS. Stored observations are never updated in place, so every company is
-- dropped (observations cascade) and synced again from EDGAR, with the fixed
-- derivation, the next time a back test, paper pass or screen needs it.
DELETE FROM "fundamental_company";
