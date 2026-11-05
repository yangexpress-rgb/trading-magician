# ADR 0031: Company data feeds and company financials

- **Status:** accepted
- **Date:** 2026-11-05
- **Design refs:** §9.2, §11, §15.4

## Context

Quantitative Research showed prices only. Yong asked for each company's financial and business
data (revenue, earnings, P/E, market cap, profile) and for its source to appear properly in
Settings › Data feeds. Alpaca, the only real provider so far, has no fundamentals. No provider
was preferred.

## Decision

- **SEC EDGAR is the first company data provider.** It is the SEC's own, free, with no sign-up or
  key, and covers every US-listed company that files 10-K and 10-Q reports, with figures exactly
  as filed (XBRL). Its "frames" API returns one figure for every filer in one request, so the
  screener can fill revenue, earnings and market cap for thousands of stocks in about a dozen
  requests a day; a keyed provider's free tier (e.g. Financial Modeling Prep's 250 calls a day)
  could not. What it lacks: a business description, CEO, analyst estimates, ETFs, and foreign
  issuers that file 20-F under IFRS. A paid provider can be added later as a second company data
  feed without changing the pages.
- **A new kind of feed, not a price feed.** Providers now offer `market_data`, `broker` or
  `fundamentals`. Company data feeds live in the same `data_feed_connection` table, are checked by
  the same feed-check loop (one small `companyconcept` request), and show health and last check,
  but they never get routes: `providerCoversVenue` is false for them, so automatic routes, route
  pickers and failover leave them alone. Settings › Data feeds lists them in their own "Company
  data feeds" section with their own Add button; the price list and the route pickers no longer
  show them. They are not behind the plan's live-data feature, since filings are public.
- **The contact is stored like a key.** The SEC asks every automated client to name a contact in
  its User-Agent and refuses requests without one. The feed's only credential field is a contact
  email, sealed like an API key (ADR 0015) so only the worker opens it, and sent only to the SEC.
  The client refuses anything that isn't an email (no header injection), calls only `sec.gov`
  hosts, and spaces requests across the process to stay under the SEC's 10 a second.
- **Company pages are a queue, like charts (ADR 0029).** The web app inserts a `company_report`
  for a ticker and polls it; the worker claims it with `claim_company_reports`, maps the ticker to
  a CIK from `company_tickers_exchange.json` (cached 12 hours; `BRK-B` is read as `BRK.B`), reads
  the submissions and company-facts files, and stores a `CompanyReport` on the row. A pending or
  12-hour-old ready report is reused; claiming deletes reports older than a day. Rows are
  tenant-isolated. The oldest active company data feed is the one used.
- **What a report holds.** Profile (SIC industry, headquarters, state of incorporation, fiscal
  year end, exchanges, filer category, website, former names), the latest cover-page share count
  (all classes added up), five fiscal years from 10-K filings (revenue, gross profit, operating
  income, net income, diluted EPS, dividends per share, diluted shares, operating cash flow,
  capital spending, cash, assets, liabilities, long-term debt, equity), and the latest annual,
  quarterly and current reports with links. Each line is read from a short list of standard
  us-gaap tags, earlier tags winning; a year's value from the latest filing wins, so restatements
  replace older numbers. Valuation (market cap, P/E, P/S, P/B, margins, ROE, debt/equity, free
  cash flow, dividend yield) is worked out in the page from the chart's last price
  (`companyMetrics`), so it moves with the price.
- **Screener columns.** When a company data feed is on, each screen adds market cap, P/E,
  revenue, revenue growth, net income, net margin and diluted EPS for the latest calendar year
  that at least 80% as many companies have reported as the year before. Market cap there is the
  last price times the year's diluted shares, and the warning under the table says so. The
  columns follow the price columns at the end of each row tuple, so older screens read as having
  none; they are hidden until a screen has them, with a pointer to Settings. A failing company
  feed blanks those columns with a warning instead of failing the screen.
- **A fake EDGAR for tests and E2E.** `@tm/sec/testing` answers the same paths and shapes as the
  transcribed `fixtures`, for two made-up companies matching the fake Alpaca's symbols, and
  refuses requests with no contact as the SEC does. The worker uses it only with `SEC_FAKE=true`,
  which production refuses outside E2E.

## Consequences

- The first company page or screen of the day downloads the ticker list (under 1 MB); a screen
  then reads about a dozen frames of a few hundred KB each, kept 12 hours for every tenant.
- Calendar-year frames lag: a year counts only once most companies have filed for it (by about
  April). Fiscal years that end mid-year are placed in the calendar year they mostly cover.
- Figures are as filed, not adjusted for splits after the filing; P/E uses the last fiscal
  year's EPS, not trailing twelve months.
- The cloud build environment cannot reach sec.gov, so the adapter is tested against the fake;
  the check against the real EDGAR is adding the feed in Settings and opening a company.
