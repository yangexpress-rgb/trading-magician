import type {
  CompanyFiling,
  CompanyReport,
  FiscalYearFacts,
  FiscalYearField,
  ScreenFacts,
} from '@tm/domain';
import { paddedCik, SecNotFoundError, type SecClient } from './client';
import type {
  SecCompanyConcept,
  SecCompanyFacts,
  SecFact,
  SecFrame,
  SecSubmissions,
  SecTickerFile,
} from './types';

/**
 * Reading EDGAR (ADR 0031): which company a ticker is, its profile and
 * filings, five fiscal years of reported financials, and, for the screener,
 * one calendar year's figures for every filer at once from the frames API.
 */

// ---------------------------------------------------------------------------
// Tickers

export interface SecListing {
  cik: string;
  name: string;
  ticker: string;
  exchange: string | null;
}

/** EDGAR writes share classes with a dash (BRK-B); feeds and the app use a dot (BRK.B). */
export const normalizeTicker = (t: string) => t.trim().toUpperCase().replace(/-/g, '.');

export async function fetchTickers(client: SecClient): Promise<Map<string, SecListing>> {
  const file = await client.www<SecTickerFile>('/files/company_tickers_exchange.json');
  const at = (name: string) => file.fields.indexOf(name);
  const [iCik, iName, iTicker, iExchange] = [at('cik'), at('name'), at('ticker'), at('exchange')];
  const out = new Map<string, SecListing>();
  for (const row of file.data) {
    const ticker = row[iTicker];
    const cik = row[iCik];
    if (typeof ticker !== 'string' || cik == null) continue;
    const key = normalizeTicker(ticker);
    if (out.has(key)) continue;
    out.set(key, {
      cik: String(cik),
      name: String(row[iName] ?? ''),
      ticker: key,
      exchange: typeof row[iExchange] === 'string' ? (row[iExchange] as string) : null,
    });
  }
  // Each pair is one company's two share classes; when EDGAR's list carries
  // only one (Fox and News Corp lacked FOXA and NWSA, 2026-11-07), the other
  // takes the same company.
  for (const [a, b] of SHARE_CLASS_SIBLINGS) {
    const from = out.get(a) ?? out.get(b);
    for (const t of [a, b]) if (from && !out.has(t)) out.set(t, { ...from, ticker: t });
  }
  return out;
}

/** S&P 500 companies with two listed share classes. */
export const SHARE_CLASS_SIBLINGS: readonly (readonly [string, string])[] = [
  ['FOXA', 'FOX'],
  ['NWSA', 'NWS'],
  ['GOOGL', 'GOOG'],
  ['BRK.B', 'BRK.A'],
];

// ---------------------------------------------------------------------------
// Concepts: the us-gaap tags each line is reported under, most common first.

const USD = 'USD';
const PER_SHARE = 'USD/shares';
const SHARES = 'shares';

const LINES: Record<FiscalYearField, { tags: string[]; unit: string; instant?: boolean }> = {
  revenue: {
    tags: [
      'Revenues',
      'RevenueFromContractWithCustomerExcludingAssessedTax',
      'RevenueFromContractWithCustomerIncludingAssessedTax',
      'SalesRevenueNet',
      'SalesRevenueGoodsNet',
      'RevenuesNetOfInterestExpense',
    ],
    unit: USD,
  },
  grossProfit: { tags: ['GrossProfit'], unit: USD },
  operatingIncome: { tags: ['OperatingIncomeLoss'], unit: USD },
  netIncome: { tags: ['NetIncomeLoss', 'ProfitLoss'], unit: USD },
  eps: { tags: ['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted'], unit: PER_SHARE },
  dividendsPerShare: {
    tags: ['CommonStockDividendsPerShareDeclared', 'CommonStockDividendsPerShareCashPaid'],
    unit: PER_SHARE,
  },
  operatingCashFlow: { tags: ['NetCashProvidedByUsedInOperatingActivities'], unit: USD },
  capitalExpenditure: { tags: ['PaymentsToAcquirePropertyPlantAndEquipment'], unit: USD },
  totalAssets: { tags: ['Assets'], unit: USD, instant: true },
  totalLiabilities: { tags: ['Liabilities'], unit: USD, instant: true },
  equity: {
    tags: [
      'StockholdersEquity',
      'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest',
    ],
    unit: USD,
    instant: true,
  },
  cash: {
    tags: [
      'CashAndCashEquivalentsAtCarryingValue',
      'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents',
    ],
    unit: USD,
    instant: true,
  },
  longTermDebt: { tags: ['LongTermDebtNoncurrent', 'LongTermDebt'], unit: USD, instant: true },
  dilutedShares: { tags: ['WeightedAverageNumberOfDilutedSharesOutstanding'], unit: SHARES },
};

const ANNUAL_FORMS = new Set(['10-K', '10-K/A', '10-KT', '10-KT/A']);
const DAY = 86_400_000;
const days = (start: string, end: string) => (Date.parse(end) - Date.parse(start)) / DAY;
/** A fiscal year runs 52 or 53 weeks, or a calendar year. */
const isYearLong = (f: SecFact) =>
  !!f.start && days(f.start, f.end) >= 350 && days(f.start, f.end) <= 380;

/** Annual values by the year's end date, the latest filing winning (restatements). */
function annualValues(facts: SecFact[] | undefined, instant: boolean): Map<string, SecFact> {
  const out = new Map<string, SecFact>();
  for (const f of facts ?? []) {
    if (!ANNUAL_FORMS.has(f.form)) continue;
    if (instant ? f.start !== undefined : !isYearLong(f)) continue;
    const had = out.get(f.end);
    if (!had || f.filed > had.filed) out.set(f.end, f);
  }
  return out;
}

function lineValues(facts: SecCompanyFacts, field: FiscalYearField): Map<string, number> {
  const line = LINES[field];
  const gaap = facts.facts['us-gaap'] ?? {};
  const out = new Map<string, number>();
  // Companies switch tags over the years (e.g. to ASC 606 revenue); earlier tags win per year.
  for (const tag of line.tags) {
    for (const [end, f] of annualValues(gaap[tag]?.units[line.unit], !!line.instant)) {
      if (!out.has(end)) out.set(end, f.val);
    }
  }
  return out;
}

/** Five fiscal years at most, oldest first, from the company's 10-K filings. */
export function fiscalYears(facts: SecCompanyFacts, limit = 5): FiscalYearFacts[] {
  const values = Object.fromEntries(
    (Object.keys(LINES) as FiscalYearField[]).map((k) => [k, lineValues(facts, k)]),
  ) as Record<FiscalYearField, Map<string, number>>;
  // Year ends are those with a year's income or revenue reported.
  // Ends a few days apart are the same year told twice; the later one is kept.
  const ends: string[] = [];
  for (const end of [...new Set([...values.netIncome.keys(), ...values.revenue.keys()])].sort()) {
    const last = ends.at(-1);
    if (last !== undefined && days(last, end) <= 300) ends[ends.length - 1] = end;
    else ends.push(end);
  }
  ends.splice(0, Math.max(0, ends.length - limit));
  return ends.map((end) => {
    const year: FiscalYearFacts = {
      // Named after the calendar year the fiscal year mostly falls in.
      fiscalYear: new Date(Date.parse(end) - 182 * DAY).getUTCFullYear(),
      end,
      revenue: null,
      grossProfit: null,
      operatingIncome: null,
      netIncome: null,
      eps: null,
      dividendsPerShare: null,
      operatingCashFlow: null,
      capitalExpenditure: null,
      totalAssets: null,
      totalLiabilities: null,
      equity: null,
      cash: null,
      longTermDebt: null,
      dilutedShares: null,
    };
    for (const k of Object.keys(LINES) as FiscalYearField[]) {
      year[k] = nearest(values[k], end);
    }
    return year;
  });
}

/** The value at a year end, allowing a few days' difference between statements. */
function nearest(values: Map<string, number>, end: string): number | null {
  const exact = values.get(end);
  if (exact !== undefined) return exact;
  for (const [at, v] of values) if (Math.abs(days(at, end)) <= 7) return v;
  return null;
}

/** The latest cover-page share count, every class added up. */
export function sharesOutstanding(facts: SecCompanyFacts): { value: number; asOf: string } | null {
  const list = facts.facts.dei?.EntityCommonStockSharesOutstanding?.units[SHARES] ?? [];
  const latest = [...list].sort(
    (a, b) => b.filed.localeCompare(a.filed) || b.end.localeCompare(a.end),
  )[0];
  if (!latest) return null;
  const sameFiling = list.filter((f) => f.accn === latest.accn && f.end === latest.end);
  return { value: sameFiling.reduce((a, f) => a + f.val, 0), asOf: latest.end };
}

// ---------------------------------------------------------------------------
// Profile and filings

const LISTED_FORMS = new Set([
  '10-K',
  '10-K/A',
  '10-Q',
  '10-Q/A',
  '8-K',
  '20-F',
  '40-F',
  '6-K',
  'DEF 14A',
  'S-1',
  'S-3',
  '424B4',
]);

const title = (s: string | null | undefined) =>
  s
    ? s
        .toLowerCase()
        .replace(/\b([a-z])/g, (m) => m.toUpperCase())
        .trim()
    : null;

export function filingUrl(
  wwwUrl: string,
  cik: string,
  accession: string,
  primaryDocument: string,
): string {
  const folder = accession.replace(/-/g, '');
  const doc = primaryDocument ? `/${encodeURIComponent(primaryDocument)}` : '/';
  return `${wwwUrl}/Archives/edgar/data/${Number(cik)}/${folder}${doc}`;
}

export function recentFilings(sub: SecSubmissions, wwwUrl: string, limit = 12): CompanyFiling[] {
  const r = sub.filings.recent;
  const out: CompanyFiling[] = [];
  for (let i = 0; i < r.form.length && out.length < limit; i++) {
    const form = r.form[i] ?? '';
    if (!LISTED_FORMS.has(form)) continue;
    out.push({
      form,
      filed: r.filingDate[i] ?? '',
      period: r.reportDate[i] || null,
      url: filingUrl(wwwUrl, sub.cik, r.accessionNumber[i] ?? '', r.primaryDocument[i] ?? ''),
      description: r.primaryDocDescription[i] || null,
    });
  }
  return out;
}

function profileOf(sub: SecSubmissions): CompanyReport['profile'] {
  const b = sub.addresses.business ?? sub.addresses.mailing;
  const city = title(b?.city);
  const state = b?.stateOrCountryDescription ?? b?.stateOrCountry ?? null;
  const fye = sub.fiscalYearEnd && /^\d{4}$/.test(sub.fiscalYearEnd) ? sub.fiscalYearEnd : null;
  const site = sub.website || sub.investorWebsite || null;
  return {
    industry: title(sub.sicDescription),
    sic: sub.sic || null,
    tickers: sub.tickers.map(normalizeTicker),
    exchanges: sub.exchanges.filter((e): e is string => !!e),
    fiscalYearEnd: fye ? `${fye.slice(0, 2)}-${fye.slice(2)}` : null,
    incorporatedIn: sub.stateOfIncorporationDescription || sub.stateOfIncorporation || null,
    headquarters: city && state ? `${city}, ${state}` : (city ?? state),
    phone: sub.phone || null,
    website: site && /^https?:\/\//i.test(site) ? site : site ? `https://${site}` : null,
    filerCategory: sub.category || null,
    formerNames: sub.formerNames.slice(0, 5).map((n) => ({
      name: title(n.name) ?? n.name,
      until: n.to ? n.to.slice(0, 10) : null,
    })),
  };
}

/** Everything the company page shows: two requests, the submissions and the company facts. */
export async function fetchCompanyReport(
  client: SecClient,
  listing: SecListing,
): Promise<CompanyReport> {
  const cik = paddedCik(listing.cik);
  const sub = await client.data<SecSubmissions>(`/submissions/CIK${cik}.json`);
  let facts: SecCompanyFacts | undefined;
  try {
    facts = await client.data<SecCompanyFacts>(`/api/xbrl/companyfacts/CIK${cik}.json`);
  } catch (error) {
    // Some filers (new listings, foreign issuers) have no XBRL financials yet.
    if (!(error instanceof SecNotFoundError)) throw error;
  }
  return {
    symbol: listing.ticker,
    name: sub.name || listing.name,
    cik: String(Number(cik)),
    profile: profileOf(sub),
    sharesOutstanding: facts ? sharesOutstanding(facts) : null,
    years: facts ? fiscalYears(facts) : [],
    filings: recentFilings(sub, client.wwwUrl),
    currency: 'USD',
    sourceUrl: `${client.wwwUrl}/edgar/browse/?CIK=${Number(cik)}`,
  };
}

// ---------------------------------------------------------------------------
// The screener: one calendar year for every filer, a few requests in all

const frameOf = async (client: SecClient, tag: string, unit: string, year: number) => {
  try {
    const frame = await client.data<SecFrame>(
      `/api/xbrl/frames/us-gaap/${tag}/${unit.replace('/', '-per-')}/CY${year}.json`,
    );
    return frame.data;
  } catch (error) {
    if (error instanceof SecNotFoundError) return [];
    throw error;
  }
};

/** cik → value, the first tag with a value winning. */
async function frameValues(client: SecClient, field: FiscalYearField, year: number) {
  const line = LINES[field];
  const out = new Map<string, number>();
  // The two or three tags nearly every filer uses; rarer ones are left to the company page.
  for (const tag of line.tags.slice(0, field === 'revenue' ? 3 : 1)) {
    for (const d of await frameOf(client, tag, line.unit, year)) {
      const cik = String(d.cik);
      if (!out.has(cik)) out.set(cik, d.val);
    }
  }
  return out;
}

/**
 * Revenue, net income, diluted EPS and diluted shares for the latest
 * calendar year most filers have reported, keyed by ticker. A year counts
 * once at least 80% as many companies have reported its net income as the
 * year before's.
 */
export async function fetchScreenFacts(
  client: SecClient,
  tickers: Map<string, SecListing>,
  now: Date,
): Promise<{ year: number; facts: Map<string, ScreenFacts> }> {
  const candidate = now.getUTCFullYear() - 1;
  const [incomeNew, incomeOld] = [
    await frameValues(client, 'netIncome', candidate),
    await frameValues(client, 'netIncome', candidate - 1),
  ];
  const year =
    incomeNew.size >= 0.8 * incomeOld.size && incomeNew.size > 0 ? candidate : candidate - 1;
  const netIncome = year === candidate ? incomeNew : incomeOld;
  const revenue = await frameValues(client, 'revenue', year);
  const revenuePrior = await frameValues(client, 'revenue', year - 1);
  const eps = await frameValues(client, 'eps', year);
  const shares = await frameValues(client, 'dilutedShares', year);
  const facts = new Map<string, ScreenFacts>();
  for (const [ticker, listing] of tickers) {
    const c = listing.cik;
    const row: ScreenFacts = {
      year,
      revenue: revenue.get(c) ?? null,
      revenuePrior: revenuePrior.get(c) ?? null,
      netIncome: netIncome.get(c) ?? null,
      eps: eps.get(c) ?? null,
      shares: shares.get(c) ?? null,
    };
    if (row.revenue !== null || row.netIncome !== null || row.eps !== null) facts.set(ticker, row);
  }
  return { year, facts };
}

// ---------------------------------------------------------------------------
// Feed checks

/** Apple's, small and always there. */
export const CHECK_CIK = '320193';

/** One small request that proves EDGAR answers with this contact. */
export async function checkSec(client: SecClient): Promise<{ ok: true }> {
  const concept = await client.data<SecCompanyConcept>(
    `/api/xbrl/companyconcept/CIK${paddedCik(CHECK_CIK)}/dei/EntityCommonStockSharesOutstanding.json`,
  );
  if (!concept || typeof concept.entityName !== 'string') {
    throw new SecNotFoundError('SEC EDGAR sent an unexpected reply');
  }
  return { ok: true };
}
