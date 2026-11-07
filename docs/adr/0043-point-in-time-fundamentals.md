# ADR 0043: Point-in-time fundamentals as strategy metrics

- **Status:** accepted
- **Date:** 2026-11-07
- **Design refs:** §6.4, §7.2, §11, §13.5; design v1.2 item 6, rows N34 to N39; builds on ADRs 0031
  (SEC EDGAR company data) and the v1.2 metric registry (item 1)

## Context

The app showed company figures (the company page, the screener's P/E, revenue and EPS) but a
strategy could not use any of them: conditions had no fundamental values, Selection groups could not
rank by P/E, and dividend yield, price-to-book and EV/EBITDA did not exist anywhere. The v1.2 brief
(item 6) asks for them as registry metrics, the same definition serving conditions, ranking and the
screener, and above all asks that a back test only see a figure once the market could know it: from
the filing's acceptance time, as originally filed, with a restatement as a new, later value.

The screener's existing figures came from EDGAR "frames" (one calendar year for every company at
once). Frames carry neither acceptance times nor as-filed history, so they cannot be used for this.

## Decision

- **Point-in-time observations.** A value is stored as `(company, field, value, periodEnd,
availableFrom, accession, form)`. `availableFrom` is the filing's acceptance time from the EDGAR
  submissions file (`acceptanceDateTime`, which EDGAR writes in New York wall time with a trailing
  Z; it is read as New York time), or 17:30 New York on the filing date when the time is unknown.
  The engine reads the latest observation with `availableFrom` at or before the bar being
  evaluated, and none when the period it describes ended more than 15 months (456 days) earlier,
  so a company that stops filing or stops paying dividends has no value rather than an old one.
- **Built by replaying filings.** EDGAR's company facts list each value once per filing that
  reported it. `pointInTimeObservations` (`@tm/sec`) walks the 10-K and 10-Q filings (with
  amendments) in acceptance order and, after each, works out the fields: trailing-twelve-month EPS,
  revenue, net income, EBITDA (operating income plus depreciation and amortization) and dividends
  declared per share (the fiscal year when one just ended, else the last four quarters, with
  quarters derived from year-to-date figures where needed); the latest balance sheet's equity,
  cash, debt (long-term debt with its current portion, plus short-term borrowings), preferred
  stock and minority interest; cover-page shares outstanding; and the dividend-growth streak from
  each 10-K's own this-year and prior-year figures. A value that changes is a new observation; an
  unchanged one is not repeated. A per-share figure restated by a whole split ratio marks a split,
  and earlier per-share figures are put on the new basis so quarters add up.
- **Today's share basis.** Per-share values and share counts are on the basis of the filing that
  made them known. At evaluation, the registry converts them to today's basis by the ratio of the
  traded to the split-adjusted daily close then and now, so a split after a filing never makes a
  stock look 4× cheaper. Metrics therefore read the raw and split-only daily closes, which back
  tests and paper runs load like any other series.
- **Registry metrics** (category `fundamental`, US stocks only): P/E (unknown when EPS ≤ 0),
  earnings yield, dividend yield, price-to-book (market cap ÷ equity, unknown when equity ≤ 0),
  EV/EBITDA (unknown when EBITDA ≤ 0), dividend-growth streak, and revenue, net income and EPS
  (TTM). Missing data is unknown, never zero, with one exception, open point O19 in
  `docs/design/v1.2-deviations.md`: EV/EBITDA counts a balance-sheet line the company does not
  report (debt, preferred stock, minority interest) as a zero balance, because most companies
  report no preferred stock or minority interest and would otherwise have no EV/EBITDA; cash is
  still required. A dividend-growth streak of 0 is a value, not missing data: the filings report
  dividends per share and the latest year's did not rise. A company whose 10-Ks report no
  dividends per share has no streak (unknown).
- **Storage.** Filings are public, so observations are kept once for every tenant in
  `fundamental_company` and `fundamental_observation` (migration 0057), which only the worker's
  login (`tm_secrets`) can read or write. An observation is never updated: a later sync adds rows.
- **Sync.** The worker fetches a company's companyfacts and submissions through the tenant's own
  SEC EDGAR feed (its contact email, as the SEC asks) when the company was last synced more than a
  day ago, before a back test or paper pass that reads fundamental metrics. Back tests wait for it,
  keeping their lease; a paper pass that can't get filings leaves the metrics unknown. Symbols map
  to companies through EDGAR's ticker list.
- **Validation.** A strategy that uses a fundamental metric needs an active company data feed
  (`missing_company_feed`).
- **Builder and screener.** The condition builder lists them as their own value type, "Fundamental
  metric (company filings)"; the ranking and fire-mode pickers group metrics into price-based and
  fundamental. The screener's P/E, dividend yield, price-to-book and EV/EBITDA columns are computed
  by the same registry definitions over the same stored observations, at the screen's last price.
  A screen syncs companies for up to a minute and says how many are still loading; the columns fill
  in on later screens.

## Consequences

- The first back test or screen over the S&P 500 makes about 1,000 SEC requests (two per company),
  roughly two minutes at the SEC's pace; afterwards a day's sync is shared by everyone.
- The screener's P/E changes meaning: it was the latest calendar year's EPS from frames, it is now
  trailing twelve months from filings, as strategies compute it. Companies not yet synced show it
  blank until they are.
- Figures become visible at the 10-Q/10-K acceptance, not at the earlier earnings press release
  (8-K), so a back test sees them a few days later than the market did. That is conservative: it
  can never look ahead.
- Real EDGAR data has not been fetched from the cloud build machine, whose network does not reach
  sec.gov; tests use a local fake. Coverage of dividends per share across the S&P 500 is checked on
  the Mac (open point O22).

## Amendment (2026-11-07): confirming stock splits

Yong's review found screener dividend yields of 158% (EL), 21% (TMUS) and 20% (SRE). The replay
took any per-share value restated by a whole ratio for a stock split, and companies report a
quarter's dividends declared in one filing and dividends paid in another, often 2× or 3× apart, so
earlier figures were rescaled, sometimes several times. A split now needs the same tag as before,
every restated value in the filing agreeing on the ratio, and the cover page's share count moving
by about that ratio since the last count; a period known as dividends declared is never replaced by
dividends paid. Migration 0061 deletes the stored companies and observations so they are synced
again with the fixed derivation (the data is public and is fetched again on the next back test,
paper pass or screen; a run before and after may differ for companies that were affected).

## Amendment (2026-11-07): a non-payer's dividend yield is 0%

Yong chose that a company paying no dividend has a 0% yield, not an unknown one. The replay emits
dividends per share (TTM) of 0 when a company's filings report earnings but neither dividends per
share nor any cash dividends paid for a period ending in the 15 months before its latest earnings.
A payer that reports cash dividends without a per-share figure stays unknown. Migration 0062
re-syncs every company so the zeros are stored.
