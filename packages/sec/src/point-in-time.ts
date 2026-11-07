import type { FundamentalField, FundamentalObservation } from '@tm/domain';
import { zonedWallTimeToIso } from '@tm/domain';
import { paddedCik, SecNotFoundError, type SecClient } from './client';
import type { SecCompanyFacts, SecFact, SecSubmissions } from './types';

/**
 * Point-in-time fundamentals from EDGAR company facts (Design v1.2 item 6,
 * ADR 0043). EDGAR's company facts list every value of every concept once
 * per filing that reported it, with that filing's accession number: the
 * value *as filed*. Replaying the filings in the order they were accepted,
 * and working out each metric input after each one, gives the values the
 * market could know at each moment. A restated figure arrives with the
 * filing that restated it, as a new observation; the original is kept.
 */

/** 10-K and 10-Q filings and their amendments; other forms carry no statements here. */
const STATEMENT_FORMS = new Set(['10-K', '10-K/A', '10-KT', '10-KT/A', '10-Q', '10-Q/A']);
const ANNUAL_FORMS = new Set(['10-K', '10-K/A', '10-KT', '10-KT/A']);

interface Concept {
  /** Tags in order of preference; within one filing the first tag with a value wins. */
  tags: readonly string[];
  unit: string;
  instant?: boolean;
  perShare?: boolean;
  taxonomy?: 'us-gaap' | 'dei';
}

const CONCEPTS = {
  revenue: {
    tags: [
      'Revenues',
      'RevenueFromContractWithCustomerExcludingAssessedTax',
      'RevenueFromContractWithCustomerIncludingAssessedTax',
      'SalesRevenueNet',
      'SalesRevenueGoodsNet',
      'RevenuesNetOfInterestExpense',
    ],
    unit: 'USD',
  },
  netIncome: { tags: ['NetIncomeLoss'], unit: 'USD' },
  operatingIncome: { tags: ['OperatingIncomeLoss'], unit: 'USD' },
  depreciation: {
    tags: [
      'DepreciationDepletionAndAmortization',
      'DepreciationAndAmortization',
      'DepreciationAmortizationAndAccretionNet',
    ],
    unit: 'USD',
  },
  eps: {
    tags: ['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted'],
    unit: 'USD/shares',
    perShare: true,
  },
  dps: {
    tags: ['CommonStockDividendsPerShareDeclared', 'CommonStockDividendsPerShareCashPaid'],
    unit: 'USD/shares',
    perShare: true,
  },
  equity: { tags: ['StockholdersEquity'], unit: 'USD', instant: true },
  cash: {
    tags: [
      'CashAndCashEquivalentsAtCarryingValue',
      'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents',
      'CashAndDueFromBanks',
    ],
    unit: 'USD',
    instant: true,
  },
  debtTotal: { tags: ['LongTermDebt'], unit: 'USD', instant: true },
  debtNoncurrent: {
    tags: ['LongTermDebtNoncurrent', 'LongTermDebtAndCapitalLeaseObligations'],
    unit: 'USD',
    instant: true,
  },
  debtCurrent: {
    tags: ['LongTermDebtCurrent', 'LongTermDebtAndCapitalLeaseObligationsCurrent', 'DebtCurrent'],
    unit: 'USD',
    instant: true,
  },
  shortBorrowings: { tags: ['ShortTermBorrowings'], unit: 'USD', instant: true },
  preferred: { tags: ['PreferredStockValue'], unit: 'USD', instant: true },
  minority: { tags: ['MinorityInterest'], unit: 'USD', instant: true },
  shares: {
    tags: ['EntityCommonStockSharesOutstanding'],
    unit: 'shares',
    instant: true,
    taxonomy: 'dei',
  },
} as const satisfies Record<string, Concept>;
type ConceptName = keyof typeof CONCEPTS;

const DAY = 86_400_000;
const days = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / DAY;
const isQuarter = (d: number) => d >= 80 && d <= 100;
const isYear = (d: number) => d >= 350 && d <= 380;

// ---------------------------------------------------------------------------
// Acceptance times

/**
 * When each filing was accepted, by accession number, from the submissions
 * file. EDGAR writes `acceptanceDateTime` with a trailing Z, but the clock
 * time is New York's (Apple's 10-Ks show 06:01, before the market opens); it
 * is read as New York time, which is never earlier than the true instant.
 */
export function acceptanceTimes(sub: SecSubmissions): Map<string, string> {
  const r = sub.filings.recent;
  const out = new Map<string, string>();
  const times = r.acceptanceDateTime ?? [];
  r.accessionNumber.forEach((accn, i) => {
    const raw = times[i];
    const m = raw && /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(raw);
    if (!m) return;
    const at = zonedWallTimeToIso(`${m[1]}T${m[2]}`, 'America/New_York');
    if (at) out.set(accn, new Date(at).toISOString());
  });
  return out;
}

/**
 * When a filing without a known acceptance time became visible: 17:30 New
 * York time on its filing date. EDGAR dates anything accepted after 17:30
 * to the next business day, so the true time is never later than this.
 */
export function filedDateAvailability(filed: string): string {
  const at = zonedWallTimeToIso(`${filed}T17:30:00`, 'America/New_York');
  return new Date(at ?? Date.parse(`${filed}T22:30:00Z`)).toISOString();
}

// ---------------------------------------------------------------------------
// Replaying filings

interface Known {
  start?: string | undefined;
  end: string;
  value: number;
  /** Index of the filing that last set it. */
  filing: number;
}

interface Filing {
  accn: string;
  form: string;
  availableFrom: string;
  facts: Map<ConceptName, SecFact[]>;
}

/** Facts per concept and filing; the first tag with a value in a filing wins for that filing. */
function collectFilings(facts: SecCompanyFacts, acceptance: ReadonlyMap<string, string>): Filing[] {
  const byAccn = new Map<string, Filing>();
  for (const [name, concept] of Object.entries(CONCEPTS) as [ConceptName, Concept][]) {
    const taxonomy = facts.facts[concept.taxonomy ?? 'us-gaap'] ?? {};
    const claimed = new Set<string>();
    for (const tag of concept.tags) {
      const list = taxonomy[tag]?.units[concept.unit] ?? [];
      const here = new Set<string>();
      for (const f of list) {
        // Only 10-K and 10-Q filings (and their cover pages) are replayed.
        if (!STATEMENT_FORMS.has(f.form)) continue;
        if (claimed.has(f.accn)) continue;
        here.add(f.accn);
        let filing = byAccn.get(f.accn);
        if (!filing) {
          filing = {
            accn: f.accn,
            form: f.form,
            availableFrom: acceptance.get(f.accn) ?? filedDateAvailability(f.filed),
            facts: new Map(),
          };
          byAccn.set(f.accn, filing);
        }
        const bucket = filing.facts.get(name) ?? [];
        bucket.push(f);
        filing.facts.set(name, bucket);
      }
      for (const a of here) claimed.add(a);
    }
  }
  return [...byAccn.values()].sort(
    (a, b) =>
      Date.parse(a.availableFrom) - Date.parse(b.availableFrom) || a.accn.localeCompare(b.accn),
  );
}

const key = (f: { start?: string | undefined; end: string }) => `${f.start ?? ''}|${f.end}`;

/** A ratio near a whole split (2, 3, 4, 1.5 …) or its inverse, if the change is one. */
function splitRatio(before: number, after: number): number | undefined {
  if (before === 0 || after === 0 || Math.sign(before) !== Math.sign(after)) return undefined;
  const r = before / after;
  const big = r >= 1 ? r : 1 / r;
  if (big < 1.4) return undefined;
  const candidates = [1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 10, 15, 20, 25, 30, 50, 100];
  const near = candidates.find((c) => Math.abs(big - c) / c < 0.04);
  if (!near) return undefined;
  return r >= 1 ? near : 1 / near;
}

/** Discrete quarters from 3-month facts and from year-to-date chains (6 − 3, 9 − 6, 12 − 9 months). */
function quartersOf(known: Iterable<Known>): Map<string, number> {
  const out = new Map<string, number>();
  const byStart = new Map<string, Known[]>();
  for (const k of known) {
    if (!k.start) continue;
    if (isQuarter(days(k.start, k.end))) out.set(k.end, k.value);
    const list = byStart.get(k.start) ?? [];
    list.push(k);
    byStart.set(k.start, list);
  }
  for (const list of byStart.values()) {
    list.sort((a, b) => a.end.localeCompare(b.end));
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1] as Known;
      const cur = list[i] as Known;
      if (isQuarter(days(prev.end, cur.end)) && !out.has(cur.end)) {
        out.set(cur.end, cur.value - prev.value);
      }
    }
  }
  return out;
}

/**
 * Trailing twelve months at the latest period known: the fiscal year when
 * one just ended, else the sum of the last four quarters (each about three
 * months after the one before). Undefined when that can't be worked out.
 */
export function trailingTwelveMonths(
  known: Iterable<Known>,
): { value: number; periodEnd: string } | undefined {
  const all = [...known];
  const quarters = quartersOf(all);
  const years = all.filter((k) => k.start && isYear(days(k.start, k.end)));
  const ends = [...quarters.keys(), ...years.map((y) => y.end)].sort();
  const latest = ends.at(-1);
  if (!latest) return undefined;
  const year = years.find((y) => Math.abs(days(y.end, latest)) <= 3);
  if (year) return { value: year.value, periodEnd: latest };
  const qEnds = [...quarters.keys()].sort();
  let total = 0;
  let end = latest;
  for (let n = 0; n < 4; n++) {
    const target = end;
    const hit = qEnds.find((e) => Math.abs(days(e, target)) <= 12);
    if (hit === undefined) return undefined;
    total += quarters.get(hit) as number;
    end = new Date(Date.parse(hit) - 91 * DAY).toISOString().slice(0, 10);
  }
  return { value: total, periodEnd: latest };
}

function latestInstant(known: Iterable<Known>): Known | undefined {
  let best: Known | undefined;
  for (const k of known) if (!best || k.end > best.end) best = k;
  return best;
}

/**
 * Years of rising dividends, judged from each annual report's own figures
 * (this year's and last year's, on the same share basis, so a split can't
 * break the streak): counted back from the latest 10-K while each showed a
 * rise and the years follow each other.
 */
function dividendStreak(
  annual: { end: string; current: number; prior: number | undefined }[],
): number | undefined {
  const latest = annual.at(-1);
  if (!latest) return undefined;
  let streak = 0;
  for (let i = annual.length - 1; i >= 0; i--) {
    const a = annual[i] as (typeof annual)[number];
    if (a.prior === undefined || !(a.current > a.prior)) break;
    streak++;
    const before = annual[i - 1];
    if (!before || !isYear(days(before.end, a.end))) break;
  }
  return streak;
}

/**
 * Every point-in-time observation the company facts support, oldest first.
 * `acceptance` maps accession numbers to acceptance instants (see
 * `acceptanceTimes`); a filing missing from it uses its filing date.
 */
export function pointInTimeObservations(
  facts: SecCompanyFacts,
  acceptance: ReadonlyMap<string, string> = new Map(),
): FundamentalObservation[] {
  const filings = collectFilings(facts, acceptance);
  const known = new Map<ConceptName, Map<string, Known>>();
  const annualDividends: { end: string; current: number; prior: number | undefined }[] = [];
  const out: FundamentalObservation[] = [];
  const last = new Map<FundamentalField, string>();

  const emit = (filing: Filing, field: FundamentalField, value: number, periodEnd: string) => {
    if (!Number.isFinite(value)) return;
    const v = String(Number(value.toPrecision(12)));
    const sig = `${v}|${periodEnd}`;
    if (last.get(field) === sig) return;
    last.set(field, sig);
    out.push({
      field,
      value: v,
      periodEnd,
      availableFrom: filing.availableFrom,
      accession: filing.accn,
      form: filing.form,
    });
  };

  filings.forEach((filing, index) => {
    // A per-share value restated by a whole ratio is a stock split: earlier per-share
    // values are put on the new basis, so quarters from before and after add up.
    let split: number | undefined;
    for (const name of ['eps', 'dps'] as const) {
      const have = known.get(name);
      for (const f of filing.facts.get(name) ?? []) {
        const had = have?.get(key(f));
        if (had && had.filing !== index) split ??= splitRatio(had.value, f.val);
      }
    }
    if (split) {
      for (const name of ['eps', 'dps'] as const) {
        for (const k of known.get(name)?.values() ?? []) k.value /= split;
      }
    }

    for (const [name, list] of filing.facts) {
      const map = known.get(name) ?? new Map<string, Known>();
      if (name === 'shares') {
        // The cover page lists each share class; they add up per date.
        const sums = new Map<string, number>();
        for (const f of list) sums.set(f.end, (sums.get(f.end) ?? 0) + f.val);
        for (const [end, value] of sums) map.set(key({ end }), { end, value, filing: index });
      } else {
        for (const f of list) {
          const isInstant = (CONCEPTS[name] as Concept).instant === true;
          if (isInstant ? f.start !== undefined : f.start === undefined) continue;
          map.set(key(f), { start: f.start, end: f.end, value: f.val, filing: index });
        }
      }
      known.set(name, map);
    }

    const ttm = (name: ConceptName) => {
      const m = known.get(name);
      return m ? trailingTwelveMonths(m.values()) : undefined;
    };
    const instant = (name: ConceptName) => {
      const m = known.get(name);
      return m ? latestInstant(m.values()) : undefined;
    };

    for (const [field, name] of [
      ['eps_ttm', 'eps'],
      ['revenue_ttm', 'revenue'],
      ['net_income_ttm', 'netIncome'],
      ['dps_ttm', 'dps'],
    ] as const) {
      const t = ttm(name);
      if (t) emit(filing, field, t.value, t.periodEnd);
    }
    const oi = ttm('operatingIncome');
    const da = ttm('depreciation');
    if (oi && da && oi.periodEnd === da.periodEnd) {
      emit(filing, 'ebitda_ttm', oi.value + da.value, oi.periodEnd);
    }
    for (const [field, name] of [
      ['equity', 'equity'],
      ['shares', 'shares'],
      ['cash', 'cash'],
      ['preferred', 'preferred'],
      ['minority_interest', 'minority'],
    ] as const) {
      const k = instant(name);
      if (k) emit(filing, field, k.value, k.end);
    }
    // Debt: long-term debt with its current portion (or the two parts), plus short-term borrowings.
    const total = instant('debtTotal');
    const nonCurrent = instant('debtNoncurrent');
    const current = instant('debtCurrent');
    const shortTerm = instant('shortBorrowings');
    const parts = total
      ? [total]
      : [nonCurrent, current].filter((k): k is Known => k !== undefined);
    const latestEnd = [...parts, ...(shortTerm ? [shortTerm] : [])]
      .map((k) => k.end)
      .sort()
      .at(-1);
    if (latestEnd) {
      const sameDate = (k: Known | undefined) => (k && k.end === latestEnd ? k.value : 0);
      const debt = parts.reduce((a, k) => a + sameDate(k), 0) + sameDate(shortTerm);
      emit(filing, 'debt', debt, latestEnd);
    }

    // Each annual report's own dividend figures: this fiscal year against the one before.
    if (ANNUAL_FORMS.has(filing.form)) {
      const own = (filing.facts.get('dps') ?? []).filter(
        (f) => f.start && isYear(days(f.start, f.end)),
      );
      const cur = own.reduce<SecFact | undefined>(
        (a, f) => (!a || f.end > a.end ? f : a),
        undefined,
      );
      if (cur) {
        const prior = own.find((f) => isYear(days(f.end, cur.end)));
        const entry = { end: cur.end, current: cur.val, prior: prior?.val };
        const at = annualDividends.findIndex((a) => a.end === cur.end);
        if (at >= 0) annualDividends[at] = entry;
        else annualDividends.push(entry);
        annualDividends.sort((a, b) => a.end.localeCompare(b.end));
        const streak = dividendStreak(annualDividends);
        if (streak !== undefined) emit(filing, 'dividend_streak', streak, cur.end);
      }
    }
  });
  return out;
}

/**
 * A company's point-in-time observations from EDGAR: two requests, the
 * submissions (for acceptance times) and the company facts. Undefined when
 * EDGAR has no XBRL financials for it (a new listing, a foreign issuer).
 */
export async function fetchPointInTime(
  client: SecClient,
  cik: string | number,
): Promise<FundamentalObservation[] | undefined> {
  const padded = paddedCik(cik);
  let facts: SecCompanyFacts;
  try {
    facts = await client.data<SecCompanyFacts>(`/api/xbrl/companyfacts/CIK${padded}.json`);
  } catch (error) {
    if (error instanceof SecNotFoundError) return undefined;
    throw error;
  }
  const sub = await client.data<SecSubmissions>(`/submissions/CIK${padded}.json`);
  return pointInTimeObservations(facts, acceptanceTimes(sub));
}
