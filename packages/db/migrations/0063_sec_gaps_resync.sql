-- 2026-11-07 (design v1.2 N49, ADR 0043): the EDGAR replay now fills a
-- dividend quarter only the untagged annual report covers, reads dividends
-- tagged by payment date, never steps back to an older period, works out EPS
-- from net income when quarters tag none, and takes the balance sheet's share
-- count when the cover page has none. Every company is dropped (observations
-- cascade) and synced again from EDGAR the next time it is needed.
DELETE FROM "fundamental_company";
