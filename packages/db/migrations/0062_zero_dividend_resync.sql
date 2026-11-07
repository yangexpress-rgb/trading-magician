-- Yong, 2026-11-07 (design v1.2 N48, ADR 0043): a company whose filings show
-- earnings but no dividends paid in the last 15 months now has dividends per
-- share of 0, so a 0% dividend yield instead of an unknown one. Stored
-- observations are never updated in place, so every company is dropped
-- (observations cascade) and synced again from EDGAR the next time a back
-- test, paper pass or screen needs it.
DELETE FROM "fundamental_company";
