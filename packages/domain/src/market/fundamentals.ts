/**
 * Company financials and profiles (ADR 0031): what a fundamentals feed
 * reports about one company, and the values worked out from it with a share
 * price. Amounts are in the company's reporting currency (US dollars for the
 * SEC's US filers); a value the filings do not give is null.
 */

/** One fiscal year from the annual report (10-K). */
export interface FiscalYearFacts {
  /** The fiscal year as the company names it, e.g. 2025. */
  fiscalYear: number;
  /** The last day of the fiscal year (YYYY-MM-DD). */
  end: string;
  revenue: number | null;
  grossProfit: number | null;
  operatingIncome: number | null;
  netIncome: number | null;
  /** Diluted earnings per share. */
  eps: number | null;
  dividendsPerShare: number | null;
  operatingCashFlow: number | null;
  capitalExpenditure: number | null;
  /** At the end of the year. */
  totalAssets: number | null;
  totalLiabilities: number | null;
  equity: number | null;
  cash: number | null;
  longTermDebt: number | null;
  /** Diluted weighted-average shares over the year. */
  dilutedShares: number | null;
}

export const FISCAL_YEAR_FIELDS = [
  'revenue',
  'grossProfit',
  'operatingIncome',
  'netIncome',
  'eps',
  'dividendsPerShare',
  'operatingCashFlow',
  'capitalExpenditure',
  'totalAssets',
  'totalLiabilities',
  'equity',
  'cash',
  'longTermDebt',
  'dilutedShares',
] as const satisfies readonly (keyof FiscalYearFacts)[];
export type FiscalYearField = (typeof FISCAL_YEAR_FIELDS)[number];

export interface CompanyFiling {
  form: string;
  /** YYYY-MM-DD. */
  filed: string;
  /** The period the filing reports on, when it has one. */
  period: string | null;
  url: string;
  description: string | null;
}

export interface CompanyProfile {
  /** The industry from the company's SIC code, e.g. "Electronic Computers". */
  industry: string | null;
  sic: string | null;
  tickers: string[];
  exchanges: string[];
  /** MM-DD of the fiscal year's end. */
  fiscalYearEnd: string | null;
  incorporatedIn: string | null;
  /** "City, State" of the business address. */
  headquarters: string | null;
  phone: string | null;
  website: string | null;
  /** The SEC's filer category, e.g. "Large accelerated filer". */
  filerCategory: string | null;
  formerNames: { name: string; until: string | null }[];
}

export interface CompanyReport {
  symbol: string;
  name: string;
  /** The SEC's company number, without leading zeros. */
  cik: string | null;
  profile: CompanyProfile;
  /** The latest count from a filing's cover page, all share classes together. */
  sharesOutstanding: { value: number; asOf: string } | null;
  /** Oldest first; at most five. */
  years: FiscalYearFacts[];
  /** Newest first. */
  filings: CompanyFiling[];
  /** The reporting currency of the amounts. */
  currency: string;
  /** A link to the company's own page at the provider. */
  sourceUrl: string | null;
}

export interface CompanyMetrics {
  marketCap: number | null;
  /** Price over the latest fiscal year's diluted EPS; null when earnings are not positive. */
  pe: number | null;
  /** Market cap over the latest year's revenue. */
  ps: number | null;
  /** Market cap over the latest year-end equity. */
  pb: number | null;
  revenueGrowthPct: number | null;
  grossMarginPct: number | null;
  operatingMarginPct: number | null;
  netMarginPct: number | null;
  /** Net income over year-end equity. */
  roePct: number | null;
  debtToEquity: number | null;
  freeCashFlow: number | null;
  dividendYieldPct: number | null;
}

const round = (n: number, places: number) => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};
const ratio = (a: number | null | undefined, b: number | null | undefined, places = 2) =>
  a == null || b == null || b === 0 ? null : round(a / b, places);
const pctOf = (a: number | null | undefined, b: number | null | undefined) =>
  a == null || b == null || !(b > 0) ? null : round((a / b) * 100, 2);
const growth = (to: number | null | undefined, from: number | null | undefined) =>
  to == null || from == null || !(from > 0) ? null : round(((to - from) / from) * 100, 2);

/** Market cap from a price and a share count; null when either is missing. */
export function marketCapOf(price: number | null | undefined, shares: number | null | undefined) {
  return price == null || shares == null || !(price > 0) || !(shares > 0)
    ? null
    : Math.round(price * shares);
}

/** Price over earnings; null unless both are positive. */
export function peOf(price: number | null | undefined, eps: number | null | undefined) {
  return price == null || eps == null || !(eps > 0) || !(price > 0) ? null : round(price / eps, 2);
}

/**
 * Valuation and margins from the latest fiscal year and a share price (the
 * last one the chart shows). Shares come from the latest cover page, else
 * the year's diluted average.
 */
export function companyMetrics(report: CompanyReport, price: number | null): CompanyMetrics {
  const latest = report.years.at(-1);
  const prior = report.years.at(-2);
  const shares = report.sharesOutstanding?.value ?? latest?.dilutedShares ?? null;
  const marketCap = marketCapOf(price, shares);
  const fcf =
    latest?.operatingCashFlow != null && latest.capitalExpenditure != null
      ? latest.operatingCashFlow - latest.capitalExpenditure
      : null;
  return {
    marketCap,
    pe: peOf(price, latest?.eps),
    ps: latest?.revenue && latest.revenue > 0 ? ratio(marketCap, latest.revenue) : null,
    pb: latest?.equity && latest.equity > 0 ? ratio(marketCap, latest.equity) : null,
    revenueGrowthPct: growth(latest?.revenue, prior?.revenue),
    grossMarginPct: pctOf(latest?.grossProfit, latest?.revenue),
    operatingMarginPct: pctOf(latest?.operatingIncome, latest?.revenue),
    netMarginPct: pctOf(latest?.netIncome, latest?.revenue),
    roePct: pctOf(latest?.netIncome, latest?.equity),
    debtToEquity:
      latest?.equity && latest.equity > 0 && latest.longTermDebt != null
        ? ratio(latest.longTermDebt, latest.equity)
        : null,
    freeCashFlow: fcf,
    dividendYieldPct: pctOf(latest?.dividendsPerShare, price),
  };
}

// ---------------------------------------------------------------------------
// Screener columns (ADR 0030, 0031)

/** What a fundamentals feed gives the screener about one company, for one calendar year. */
export interface ScreenFacts {
  /** The calendar year the values are for. */
  year: number;
  revenue: number | null;
  /** The year before, for growth. */
  revenuePrior: number | null;
  netIncome: number | null;
  eps: number | null;
  /** Diluted weighted-average shares over the year. */
  shares: number | null;
}

/** The screener's company columns, after the price columns on the wire. */
export const SCREEN_FUNDAMENTAL_COLUMNS = [
  'marketCap',
  'pe',
  'revenue',
  'revenueGrowthPct',
  'netIncome',
  'netMarginPct',
  'eps',
] as const;
export type ScreenFundamentalColumn = (typeof SCREEN_FUNDAMENTAL_COLUMNS)[number];

export function screenFundamentals(
  facts: ScreenFacts | undefined,
  last: number | null,
): Record<ScreenFundamentalColumn, number | null> {
  return {
    marketCap: marketCapOf(last, facts?.shares),
    pe: peOf(last, facts?.eps),
    revenue: facts?.revenue ?? null,
    revenueGrowthPct: growth(facts?.revenue, facts?.revenuePrior),
    netIncome: facts?.netIncome ?? null,
    netMarginPct: pctOf(facts?.netIncome, facts?.revenue),
    eps: facts?.eps ?? null,
  };
}
