import { nyDate, timeSeriesSue, zonedWallTimeToIso, type QuarterEps } from '@tm/domain';
import { paddedCik, type SecClient } from './client';
import { filingUrl } from './edgar';
import { filedDateAvailability } from './point-in-time';
import type { SecCompanyFacts, SecFact, SecSubmissions, SecSubmissionsPage } from './types';

/**
 * Earnings from EDGAR (free data feeds brief v1 §5.2, ADR 0058): which 8-Ks
 * announce results (Item 2.02 "Results of Operations and Financial
 * Condition"), and each quarter's diluted EPS as filed in the 10-Q or 10-K,
 * point in time, for the time-series SUE.
 */

export interface EdgarFiling {
  accession: string;
  form: string;
  filingDate: string;
  /** When EDGAR accepted it (ISO); 17:30 New York on the filing date when unknown. */
  acceptedAt: string;
  timeKnown: boolean;
  items: string[];
  primaryDocument: string;
  url: string;
}

function pageFilings(page: SecSubmissionsPage, cik: string, wwwUrl: string): EdgarFiling[] {
  return page.accessionNumber.map((accession, i) => {
    const filingDate = page.filingDate[i] ?? '';
    const raw = page.acceptanceDateTime?.[i];
    const m = raw ? /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(raw) : null;
    // EDGAR writes New York wall time with a trailing Z (see acceptanceTimes).
    const at = m ? zonedWallTimeToIso(`${m[1]}T${m[2]}`, 'America/New_York') : undefined;
    const primaryDocument = page.primaryDocument[i] ?? '';
    return {
      accession,
      form: page.form[i] ?? '',
      filingDate,
      acceptedAt: at ? new Date(at).toISOString() : filedDateAvailability(filingDate),
      timeKnown: !!at,
      items: (page.items?.[i] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      primaryDocument,
      url: filingUrl(wwwUrl, cik, accession, primaryDocument),
    };
  });
}

/**
 * A company's filings since `fromDate`, newest first: the submissions
 * file's recent list, plus the older pages it names when the recent list
 * doesn't reach back that far (busy filers such as banks).
 */
export async function fetchFilings(
  client: SecClient,
  cik: string,
  fromDate: string,
): Promise<{ submissions: SecSubmissions; filings: EdgarFiling[] }> {
  const submissions = await client.data<SecSubmissions>(`/submissions/CIK${paddedCik(cik)}.json`);
  const filings = pageFilings(submissions.filings.recent, cik, client.wwwUrl);
  const oldest = filings.at(-1)?.filingDate;
  if (oldest && oldest > fromDate) {
    for (const f of submissions.filings.files ?? []) {
      if (f.filingTo < fromDate) continue;
      const page = await client.data<SecSubmissionsPage>(`/submissions/${f.name}`);
      filings.push(...pageFilings(page, cik, client.wwwUrl));
    }
  }
  return { submissions, filings: filings.filter((f) => f.filingDate >= fromDate) };
}

/** 8-Ks that announce results: Item 2.02 (amendments are corrections, not new releases). */
export function earningsReleaseFilings(filings: readonly EdgarFiling[]): EdgarFiling[] {
  return filings
    .filter((f) => f.form === '8-K' && f.items.includes('2.02'))
    .sort((a, b) => a.acceptedAt.localeCompare(b.acceptedAt));
}

export function fetchCompanyFacts(client: SecClient, cik: string) {
  return client.data<SecCompanyFacts>(`/api/xbrl/companyfacts/CIK${paddedCik(cik)}.json`);
}

const STATEMENT_FORMS = new Set(['10-K', '10-K/A', '10-KT', '10-KT/A', '10-Q', '10-Q/A']);
const EPS_TAGS = ['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted'];
const DAY = 86_400_000;
const span = (f: SecFact) => (f.start ? (Date.parse(f.end) - Date.parse(f.start)) / DAY : 0);
const round = (v: number) => Math.round(v * 1e6) / 1e6;

export interface FiledQuarterEps extends QuarterEps {
  /** Filing date of the value used; for a derived fourth quarter, the 10-K's. */
  filed: string;
  derived: boolean;
}

/**
 * Quarterly diluted EPS as known on `asOfFiled` (YYYY-MM-DD; all filings
 * when absent), oldest first. Each quarter takes the latest value filed by
 * then, so a split restated in a later 10-Q's comparatives is picked up.
 * Most companies report no fourth quarter on its own: it is the fiscal
 * year's EPS less its three quarters (approximate, as share counts move).
 */
export function quarterlyEps(facts: SecCompanyFacts, asOfFiled?: string): FiledQuarterEps[] {
  const gaap = facts.facts['us-gaap'] ?? {};
  let values: SecFact[] = [];
  for (const tag of EPS_TAGS) {
    const v = gaap[tag]?.units['USD/shares'];
    if (v && v.length > 0) {
      values = v;
      break;
    }
  }
  const visible = values.filter(
    (f) => STATEMENT_FORMS.has(f.form) && (!asOfFiled || f.filed <= asOfFiled),
  );
  const latestBy = (keep: (f: SecFact) => boolean) => {
    const out = new Map<string, SecFact>();
    for (const f of visible) {
      if (!keep(f)) continue;
      const had = out.get(f.end);
      if (!had || f.filed > had.filed) out.set(f.end, f);
    }
    return out;
  };
  const quarters = latestBy((f) => span(f) >= 80 && span(f) <= 100);
  const years = latestBy((f) => span(f) >= 350 && span(f) <= 380);
  const out = new Map<string, FiledQuarterEps>();
  for (const [end, f] of quarters)
    out.set(end, { quarterEnd: end, eps: f.val, filed: f.filed, derived: false });
  for (const [end, y] of years) {
    if (out.has(end) || !y.start) continue;
    const start = y.start;
    const inside = [...quarters.values()].filter((q) => q.end > start && q.end < end);
    if (inside.length !== 3) continue;
    const q4 = y.val - inside.reduce((s, q) => s + q.val, 0);
    out.set(end, { quarterEnd: end, eps: round(q4), filed: y.filed, derived: true });
  }
  return [...out.values()].sort((a, b) => a.quarterEnd.localeCompare(b.quarterEnd));
}

/** The quarter end in `series` within 10 days of `end` (52/53-week years drift), if any. */
export function matchQuarter<T extends QuarterEps>(series: readonly T[], end: string) {
  return series.find((q) => Math.abs(Date.parse(q.quarterEnd) - Date.parse(end)) <= 10 * DAY);
}

/**
 * A release's SUE from the company facts: EPS of the quarter as first filed,
 * with the earlier quarters as known on that filing date (point in time).
 * Undefined until the quarter's EPS is on EDGAR.
 */
export function releaseSue(facts: SecCompanyFacts, fiscalQuarterEnd: string) {
  const all = quarterlyEps(facts);
  const q = matchQuarter(all, fiscalQuarterEnd);
  if (!q) return undefined;
  // The first filing that reported this quarter (later ones may restate it).
  const firstFiled = quarterlyEps(facts, q.filed).find((x) => x.quarterEnd === q.quarterEnd);
  const asOf = firstFiled?.filed ?? q.filed;
  const series = quarterlyEps(facts, asOf).filter((x) => x.quarterEnd <= q.quarterEnd);
  const result = timeSeriesSue(series);
  const eps = series.at(-1)?.eps;
  return eps === undefined ? undefined : { eps, filed: asOf, result };
}

/** The New York date of an instant, for an announcement's date. */
export const announcedDateOf = (iso: string) => nyDate(new Date(iso));
