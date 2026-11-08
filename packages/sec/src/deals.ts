import type { DealConfidence, DealConsideration, DealStatus } from '@tm/domain';
import type { SecClient } from './client';
import type { EdgarFiling } from './earnings';
import type { SecSearchHit, SecSearchResult } from './types';

/**
 * The merger-deal tracker's EDGAR side (free data feeds brief v1 D3, §5.3,
 * ADR 0058). No free structured M&A feed exists, so deals are read from
 * filings: 8-Ks with Item 1.01 that enter into an Agreement and Plan of
 * Merger, and tender-offer recommendations (Schedule 14D-9) filed by the
 * target. The wording varies, so the parser pins down what it can and says
 * what it could not; anything guessed makes the deal low-confidence.
 */

// ---------------------------------------------------------------------------
// Full-text search

export interface SearchFilter {
  /** Exact phrase searched for. */
  phrase: string;
  forms: string[];
  from: string;
  to: string;
}

/** The searches the tracker runs per date range. */
export const DEAL_SEARCHES: readonly Omit<SearchFilter, 'from' | 'to'>[] = [
  { phrase: 'Agreement and Plan of Merger', forms: ['8-K'] },
  { phrase: 'Offer to Purchase', forms: ['SC 14D9'] },
];

const PAGE = 100;
/** EDGAR full-text search returns at most this many hits per query. */
const MAX_HITS = 10_000;

/** Every hit of a full-text search, page by page. */
export async function searchFilings(client: SecClient, f: SearchFilter): Promise<SecSearchHit[]> {
  const out: SecSearchHit[] = [];
  for (let from = 0; from < MAX_HITS; from += PAGE) {
    const q = new URLSearchParams({
      q: `"${f.phrase}"`,
      dateRange: 'custom',
      startdt: f.from,
      enddt: f.to,
      forms: f.forms.join(','),
      from: String(from),
    });
    const res = await client.efts<SecSearchResult>(`/LATEST/search-index?${q.toString()}`);
    const hits = res.hits?.hits ?? [];
    out.push(...hits);
    if (hits.length < PAGE || out.length >= (res.hits?.total?.value ?? 0)) break;
  }
  return out;
}

export interface FilerName {
  name: string;
  tickers: string[];
  cik: string;
}

/** "Catalent, Inc.  (CTLT)  (CIK 0001596783)" → its name, tickers and CIK. */
export function parseDisplayName(display: string): FilerName {
  const cik = /\(CIK\s*0*(\d+)\)/.exec(display)?.[1] ?? '';
  const withoutCik = display.replace(/\(CIK[^)]*\)/, '').trim();
  const tick = /\(([A-Z0-9.\-, ]+)\)\s*$/.exec(withoutCik);
  const tickers = tick
    ? (tick[1] ?? '')
        .split(',')
        .map((t) => t.trim().replace(/-/g, '.'))
        .filter(Boolean)
    : [];
  const name = (tick ? withoutCik.slice(0, tick.index) : withoutCik).replace(/\s+/g, ' ').trim();
  return { name, tickers, cik };
}

/** A hit's announcing filing: who filed it, and where the document is. */
export interface DealFilingHit {
  accession: string;
  form: string;
  filedDate: string;
  items: string[];
  filer: FilerName;
  /** Every company the filing names (filer, subject company). */
  companies: FilerName[];
  documentPath: string;
}

export function dealFilingHit(hit: SecSearchHit): DealFilingHit | undefined {
  const [accession, file] = hit._id.split(':');
  const companies = (hit._source.display_names ?? []).map(parseDisplayName);
  const filerCik = String(Number(hit._source.ciks?.[0] ?? companies[0]?.cik ?? ''));
  const filer = companies.find((c) => c.cik === filerCik) ?? companies[0];
  if (!accession || !file || !filer) return undefined;
  return {
    accession,
    form: hit._source.form,
    filedDate: hit._source.file_date,
    items: hit._source.items ?? [],
    filer,
    companies,
    documentPath: `/Archives/edgar/data/${Number(filer.cik)}/${accession.replace(/-/g, '')}/${file}`,
  };
}

// ---------------------------------------------------------------------------
// Reading the filing

/** Filing HTML as plain text: tags, entities and runs of space removed, quotes made straight. */
export function filingText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#8220;|&#8221;|&ldquo;|&rdquo;|&#x201c;|&#x201d;|[“”]/gi, '"')
    .replace(/&#8217;|&#8216;|&rsquo;|&lsquo;|&#x2019;|[‘’]/gi, "'")
    .replace(/&#36;/g, '$')
    .replace(/&#\d+;/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface ParsedDeal {
  /** Whether the filer is the company being acquired, the acquirer, or neither could be told. */
  role: 'target' | 'acquirer' | 'unknown';
  acquirerName: string | null;
  /** The target's name when the filer is the acquirer. */
  targetName: string | null;
  offerPrice: number | null;
  consideration: DealConsideration;
  confidence: DealConfidence;
  /** What could not be pinned down. */
  notes: string[];
}

const MONEY = String.raw`\$\s?(\d{1,4}(?:,\d{3})*(?:\.\d{1,4})?)`;
const CASH_PATTERNS = [
  new RegExp(
    String.raw`right to receive,?\s+(?:an amount in cash(?: equal to)?|cash in an amount equal to)\s+${MONEY}`,
    'gi',
  ),
  new RegExp(String.raw`right to receive\s+${MONEY}\s+(?:per share\s+)?in cash`, 'gi'),
  new RegExp(
    String.raw`${MONEY}\s+per (?:share|Share)(?: of [A-Za-z ]{0,40}?stock)?,?\s+(?:net to the (?:seller|holder)s?\s+)?in cash`,
    'gi',
  ),
  new RegExp(
    String.raw`(?:for|at) a (?:purchase )?price of\s+${MONEY}\s+per (?:share|Share)`,
    'gi',
  ),
];
const STOCK_PATTERN =
  /exchange ratio|\d+\.\d+\s+(?:\(the "Exchange Ratio"\)\s+)?(?:of a\s+)?(?:validly issued,?\s+fully paid\s+(?:and|&)\s+nonassessable\s+)?shares? of (?:Parent|Acquir\w+|Buyer|[A-Z][\w&.\- ]{1,60}?) (?:common|ordinary|Class A)/i;
const ROLE_PARTY = '(?:Parent|Acquir(?:er|or)|Buyer|Purchaser)';
const ACQUIRER_PATTERNS = [
  new RegExp(
    String.raw`with\s+([A-Z][A-Za-z0-9.,&'\- ]{1,100}?),?\s+(?:an?|the)\s+[A-Za-z.\- ]{0,80}?\(\s*(?:the\s+)?"${ROLE_PARTY}"\s*\)`,
  ),
  new RegExp(
    String.raw`with\s+([A-Z][A-Za-z0-9.,&'\- ]{1,100}?)\s*\(\s*(?:the\s+)?"${ROLE_PARTY}"\s*\)`,
  ),
  new RegExp(
    String.raw`([A-Z][A-Za-z0-9.,&'\- ]{1,100}?),?\s+(?:an?\s+[A-Za-z.\- ]{0,80}?)?\(\s*(?:the\s+)?"${ROLE_PARTY}"\s*\)`,
  ),
];
const TARGET_IS_FILER = [
  /merge (?:with and )?into the Company/i,
  /the Company (?:will |would |shall )?(?:continue|continuing|surviving|survive)\s+(?:as\s+)?(?:the\s+)?surviving/i,
  /the Company (?:will|would|shall) (?:become|continue as) an? (?:direct or indirect )?wholly[- ]owned subsidiary/i,
  /(?:each|every) (?:issued and outstanding )?share of (?:the Company's|Company) (?:common|Common)/i,
  /tender offer (?:\(the "Offer"\) )?to (?:purchase|acquire) all (?:of )?the (?:issued and )?outstanding shares of (?:common stock of )?the Company/i,
];
const TARGET_NAMED = new RegExp(
  String.raw`(?:Merger Sub|Purchaser)\s+(?:will|would|shall)\s+(?:be\s+)?merge[ds]?\s+(?:with and )?into\s+([A-Z][A-Za-z0-9.,&'\- ]{1,100}?)\s*(?:\(|,|\s+with\b)`,
);

const cleanName = (s: string) =>
  s
    .replace(/^(?:and|with)\s+/i, '')
    .replace(/[,\s]+$/, '')
    .trim();

/**
 * What an announcing filing says about a deal (§5.3). A deal is
 * high-confidence only when the target filed it and the acquirer, the
 * consideration and, for cash, one offer price were all found; a missing
 * offer price stays null, never zero.
 */
export function parseMergerFiling(text: string): ParsedDeal {
  const notes: string[] = [];
  let role: ParsedDeal['role'] = 'unknown';
  let targetName: string | null = null;
  if (TARGET_IS_FILER.some((p) => p.test(text))) role = 'target';
  else {
    const named = TARGET_NAMED.exec(text)?.[1];
    if (named && !/^the Company$/i.test(named)) {
      role = 'acquirer';
      targetName = cleanName(named);
    }
  }
  if (role === 'unknown') notes.push('could not tell whether the filer is the target');

  let acquirerName: string | null = null;
  for (const p of ACQUIRER_PATTERNS) {
    const m = p.exec(text);
    if (m?.[1]) {
      acquirerName = cleanName(m[1]);
      break;
    }
  }
  if (!acquirerName && role !== 'acquirer') notes.push('acquirer not found');

  const prices = new Set<number>();
  for (const p of CASH_PATTERNS)
    for (const m of text.matchAll(p)) {
      const v = Number((m[1] ?? '').replace(/,/g, ''));
      if (v > 0 && v < 100_000) prices.add(v);
    }
  const stock = STOCK_PATTERN.test(text);
  const cvr = /contingent value right/i.test(text);
  const consideration: DealConsideration =
    prices.size > 0 && stock ? 'mixed' : prices.size > 0 ? 'cash' : stock ? 'stock' : 'unknown';
  let offerPrice: number | null = null;
  if (consideration === 'cash') {
    if (prices.size === 1) offerPrice = [...prices][0] as number;
    else notes.push(`several cash amounts per share (${[...prices].join(', ')})`);
  } else if (consideration === 'unknown') notes.push('consideration not found');
  else notes.push('stock consideration: no fixed cash value (O3)');
  if (cvr) notes.push('a contingent value right is paid on top of the cash');

  const confidence: DealConfidence =
    role === 'target' &&
    acquirerName !== null &&
    consideration !== 'unknown' &&
    (consideration !== 'cash' || offerPrice !== null) &&
    !cvr
      ? 'high'
      : 'low';
  return { role, acquirerName, targetName, offerPrice, consideration, confidence, notes };
}

/** Whether filing text is about entering into a merger at all (not, say, a credit agreement). */
export const looksLikeMerger = (text: string) =>
  /Agreement and Plan of Merger|Merger Agreement|tender offer/i.test(text) &&
  /merge|tender offer|Offer to Purchase/i.test(text);

// ---------------------------------------------------------------------------
// Status from the target's later filings

const PENDING_FORMS = new Set(['PREM14A', 'DEFM14A', 'DEFM14C', 'PREM14C', 'SC 14D9', '425']);
const DELISTING_FORMS = new Set(['25-NSE', '15-12B', '15-12G', '15-15D']);

export interface StatusChange {
  status: DealStatus;
  filing: EdgarFiling;
  /** Needs the filing's text to be sure: an 8-K Item 1.02 terminates *some* agreement. */
  needsText?: boolean;
}

/**
 * Status changes the target's filings after the announcement imply, in
 * filing order: a merger proxy or tender-offer filing makes it pending; an
 * 8-K Item 2.01 (completion of acquisition) or a delisting closes it; an
 * 8-K Item 1.02 that terminates the merger agreement withdraws it.
 */
export function statusChanges(
  filings: readonly EdgarFiling[],
  afterAccession: string,
  announcedAt: string,
): StatusChange[] {
  const later = filings
    .filter((f) => f.accession !== afterAccession && f.acceptedAt > announcedAt)
    .sort((a, b) => a.acceptedAt.localeCompare(b.acceptedAt));
  const out: StatusChange[] = [];
  for (const f of later) {
    if (PENDING_FORMS.has(f.form)) out.push({ status: 'pending', filing: f });
    else if (DELISTING_FORMS.has(f.form)) out.push({ status: 'closed', filing: f });
    else if (f.form === '8-K' && f.items.includes('2.01'))
      out.push({ status: 'closed', filing: f });
    else if (f.form === '8-K' && f.items.includes('1.02'))
      out.push({ status: 'withdrawn', filing: f, needsText: true });
  }
  return out;
}

/** Whether an 8-K's text terminates the merger agreement (not a credit line at closing). */
export const terminatesMerger = (text: string) =>
  /terminat\w*\s+(?:of\s+)?(?:the\s+)?(?:Merger Agreement|Agreement and Plan of Merger)/i.test(
    text,
  ) ||
  /(?:Merger Agreement|Agreement and Plan of Merger)[^.]{0,120}?(?:was|has been|is)\s+terminated/i.test(
    text,
  );

// ---------------------------------------------------------------------------
// Matching a target named by an acquirer to a listed company

const SUFFIXES =
  /\b(?:incorporated|inc|corporation|corp|company|co|limited|ltd|plc|holdings?|group|n\.?v|s\.?a|llc|l\.?p)\b\.?/gi;

/** A company name reduced for matching: lower case, no punctuation or legal suffixes. */
export const nameKey = (name: string) =>
  name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(SUFFIXES, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
