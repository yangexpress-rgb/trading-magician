# ADR 0058: Free earnings, deals and rates data

- **Status:** accepted
- **Date:** 2026-11-08
- **Design refs:** §6.4, §9.2, §11, §13.6, §20; design v1.2 rows N135 to N146, open points O106 to
  O114; free data feeds brief v1 (earnings + deals). Builds on ADR 0031 (SEC EDGAR company data),
  0040 (metric registry), 0047 (end-of-day options signals and the daily recording) and 0050 (the
  admin's key for platform jobs)

## Context

Two strategies in the Strategy Library could not be run for want of data: post-earnings-announcement
drift (PEAD) needs release times and an earnings surprise, and merger arbitrage needs announced deals
and their offer prices. Dual momentum could also use the T-bill rate as its hurdle instead of zero.
The brief asks for all of it from free sources: SEC EDGAR as the record, an optional free calendar
feed (FMP or Finnhub) for the dates ahead, and the FRED DTB3 rate the options computation already
reads. The options data build is the template: global data, worker-only writes, a metric registry
family, point-in-time back test reads, a history rebuild to February 2024.

## Decision

- **Storage (migration 0075).** `earnings_release`, `earnings_sue`, `earnings_calendar`,
  `deal_event`, `deal_status_history`, `rates_daily` and `event_scan_state`. No tenant column: the
  rows are public filings and rates. `tm_secrets` (the worker) writes; `tm_app` reads. Deals have no
  DELETE grant and the status history takes only INSERT. Deal ids are `D` and five or more digits,
  issued under a table lock so they stay gapless in the order the tracker records them.
- **Releases from 8-K Item 2.02.** Each evening (after 18:30 New York) the worker reads the
  submissions of the S&P 500 members plus every stock a strategy uses, takes new 8-Ks listing Item
  2.02, and stores the release at the filing's acceptance time. The quarter is matched from
  companyfacts. EPS comes from the 10-Q or 10-K (point in time, by filing date; Q4 is the year less
  three quarters), so a new release is stored with EPS empty and completed when that report is filed,
  looked for 120 days (O111).
- **Time-series SUE, population SD.** (EPS − EPS a year earlier) ÷ the population SD of the previous
  8 such differences; null with fewer than 8 or an SD of 0. The brief's fixture (0.25 ÷ 0.10 = 2.50)
  is asserted. A `recorded` row is never replaced by a `rebuilt` one.
- **Calendar is convenience data.** Providers `fmp` and `finnhub` offer `earnings` and take a free key,
  sealed like any feed key. The nightly job asks for 90 days in 30-day windows (one call per window,
  not per symbol), FMP first and Finnhub as fallback. Keys: `FMP_API_KEY` / `FINNHUB_API_KEY`, else
  the oldest platform admin's active feed. `EARNINGS_CALENDAR_PROVIDER` (`fmp` default, `finnhub`,
  `none`) is the kill switch. No key, an error or `none` means EDGAR-only mode: logged, said in the UI,
  never a crash, and never a block on the options recording. A calendar date never overwrites a
  release. Consensus estimates near a release fill `estimated_eps` and the surprise (O107). The
  feed's health in Settings comes from the last nightly fetch; checking a feed never calls the vendor.
- **Deals from EDGAR full-text search.** Daily, the tracker searches 8-Ks for "Agreement and Plan of
  Merger" and SC 14D9 filings for "Offer to Purchase", reads the filing and parses target, acquirer,
  offer per share and consideration. A target-filed 8-K with one cash price is high confidence; an
  acquirer-filed one, a guessed field, or a stock or mixed deal is low confidence or has a null offer
  (O108, O113). Status follows the target's later filings: a merger proxy, SC 14D9 or 425 makes it
  pending; 8-K Item 2.01 or a delisting (25-NSE, 15-12B) closes it; 8-K Item 1.02 that terminates the
  merger withdraws it. Closed and withdrawn are final; each change is appended to the history.
- **Rates without a new fetch.** The options market-inputs code calls `onRates` after each fresh
  DTB3 fetch, and the worker stores the days in `rates_daily`. So `rates.tbill_3m` reads exactly the
  rate the options computation uses.
- **History rebuild.** On its first pass the worker rebuilds releases, SUE and deals back to 1
  February 2024 (O109), marked `rebuilt`, at the SEC's 10 requests a second with a contact
  User-Agent: `SEC_CONTACT_EMAIL`, else the admin's SEC EDGAR feed. `event_scan_state` records how far
  each job has read; a deals rebuild stopped part-way resumes after its last finished month, and an
  earnings rebuild skips releases already stored.
- **Metrics.** Six registry metrics in three categories: `earnings.days_since_earnings`,
  `earnings.sue_ts`, `earnings.surprise_pct`, `earnings.next_earnings_days` (stocks), `deals.spread_pct`
  (stocks) and `rates.tbill_3m` (any priced instrument). Each reads the latest record on or before the
  bar; a release after the close counts from the next bar, and a deal's status change counts from the
  next trading day. The spread is null, never zero, without a high-confidence cash offer and an
  active deal. The Lab lists them under "Earnings, deals and rates (EDGAR, FRED)"; no new condition
  type.
- **Back tests.** The engine loads only the rows a definition names. A check's values say which record
  they used. A run that ends before the first record fails by name ("No earnings data for AAPL yet: the
  recording starts with the next release", "No earnings data for AAPL before 2024-02-01", and the deal
  and T-bill equivalents); a run that starts before it gets a coverage warning.
- **Fire when "once per cycle" for event entries (O112).** "On a change to true" needs a false
  first, and an event metric is unknown before its first record, so the fixtures use "once per cycle".
- **Research.** A stock's page gets an Earnings section (releases, EPS, SUE, surprise, 8-K link, next
  date or the EDGAR-only notice); Research gets a Deals page. The Deals page's close is the latest one
  the options recording stored (O114).

## Strategy Library note (brief §10 item 4)

The data the Library's **post-earnings-announcement drift** and **merger arbitrage** entries need now
exists in the app: earnings release times and the time-series SUE from SEC EDGAR from February 2024,
and a deal tracker with offer prices and spreads from EDGAR filings from February 2024. The PEAD rule
reads `earnings.days_since_earnings ≤ 5 AND earnings.sue_ts > 1.0` with a 60-day time stop; the
merger-arbitrage rule reads `deals.spread_pct > 0.03` and exits when the spread becomes unknown (deal
closed or withdrawn) or after 120 days. Dual momentum can compare against `rates.tbill_3m`. As the
build was asked, the Library entries themselves were not edited; this note is the record.

## Consequences

- The PEAD and merger-arbitrage fixtures back test over February 2024 to November 2026 in tests, from
  recorded filings. Real EDGAR results depend on the staging rebuild, which needs a contact email.
- Live PEAD entries follow the 10-Q, not the 8-K, until the press-release exhibit is parsed (O111).
- Free calendar data is prototype-only. The launch gate is unchanged by this build; before charging
  subscribers the vendors' terms need a re-check, or the kill switch goes to `none` (O110).
- Not in this build: intraday bars, options or futures as traded assets, FX, any paid tier (FMP
  Starter would add an M&A endpoint).
