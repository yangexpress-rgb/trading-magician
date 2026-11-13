import type { FundamentalField } from '@tm/domain';
import { latestObservation } from '@tm/domain';
import { describe, expect, it } from 'vitest';
import { acceptanceTimes, filedDateAvailability, pointInTimeObservations } from './point-in-time';
import type { SecCompanyFacts, SecFact, SecSubmissions } from './types';

/** A filing: accession, form, date filed, and the facts it reported. */
interface F {
  accn: string;
  form: string;
  filed: string;
  facts: Record<string, [start: string | undefined, end: string, val: number][]>;
}

const UNITS: Record<string, string> = {
  EarningsPerShareDiluted: 'USD/shares',
  CommonStockDividendsPerShareDeclared: 'USD/shares',
  CommonStockDividendsPerShareCashPaid: 'USD/shares',
  EarningsPerShareBasicAndDiluted: 'USD/shares',
  EntityCommonStockSharesOutstanding: 'shares',
  CommonStockSharesOutstanding: 'shares',
};

function companyFacts(filings: F[]): SecCompanyFacts {
  const usGaap: Record<
    string,
    { label: null; description: null; units: Record<string, SecFact[]> }
  > = {};
  const dei: typeof usGaap = {};
  for (const f of filings) {
    for (const [tag, rows] of Object.entries(f.facts)) {
      const target = tag.startsWith('Entity') ? dei : usGaap;
      const unit = UNITS[tag] ?? 'USD';
      const concept = (target[tag] ??= { label: null, description: null, units: {} });
      const list = (concept.units[unit] ??= []);
      for (const [start, end, val] of rows) {
        list.push({
          ...(start ? { start } : {}),
          end,
          val,
          accn: f.accn,
          fy: null,
          fp: null,
          form: f.form,
          filed: f.filed,
        });
      }
    }
  }
  return { cik: 1, entityName: 'Test', facts: { 'us-gaap': usGaap, dei } };
}

const asOf = (
  obs: ReturnType<typeof pointInTimeObservations>,
  field: FundamentalField,
  at: string,
) => latestObservation(obs, field, Date.parse(at))?.value.toNumber();

// A calendar-year company: quarters of 2024 by 10-Q, the year by 10-K, then 2025.
const Q = (y: number) => ({
  q1: [`${y}-01-01`, `${y}-03-31`],
  h1: [`${y}-01-01`, `${y}-06-30`],
  q2: [`${y}-04-01`, `${y}-06-30`],
  m9: [`${y}-01-01`, `${y}-09-30`],
  q3: [`${y}-07-01`, `${y}-09-30`],
  fy: [`${y}-01-01`, `${y}-12-31`],
});
const q24 = Q(2024);
const q25 = Q(2025);
const q23 = Q(2023);

const filings: F[] = [
  {
    accn: 'A-24Q1',
    form: '10-Q',
    filed: '2024-05-01',
    facts: {
      EarningsPerShareDiluted: [[...(q24.q1 as [string, string]), 1.0]],
      Revenues: [[...(q24.q1 as [string, string]), 100]],
      StockholdersEquity: [[undefined, '2024-03-31', 500]],
      EntityCommonStockSharesOutstanding: [[undefined, '2024-04-20', 1000]],
    },
  },
  {
    accn: 'A-24Q2',
    form: '10-Q',
    filed: '2024-08-01',
    facts: {
      // A 10-Q reports the quarter and the half year to date.
      EarningsPerShareDiluted: [
        [...(q24.q2 as [string, string]), 1.1],
        [...(q24.h1 as [string, string]), 2.1],
      ],
      Revenues: [
        [...(q24.q2 as [string, string]), 110],
        [...(q24.h1 as [string, string]), 210],
      ],
    },
  },
  {
    accn: 'A-24Q3',
    form: '10-Q',
    filed: '2024-11-01',
    facts: {
      // Only the nine months: the quarter comes from the year-to-date chain.
      EarningsPerShareDiluted: [[...(q24.m9 as [string, string]), 3.3]],
      Revenues: [[...(q24.m9 as [string, string]), 330]],
    },
  },
  {
    accn: 'A-24K',
    form: '10-K',
    filed: '2025-02-20',
    facts: {
      EarningsPerShareDiluted: [[...(q24.fy as [string, string]), 4.6]],
      Revenues: [[...(q24.fy as [string, string]), 460]],
      CommonStockDividendsPerShareDeclared: [
        [...(q24.fy as [string, string]), 1.2],
        [...(q23.fy as [string, string]), 1.0],
      ],
      LongTermDebt: [[undefined, '2024-12-31', 300]],
      ShortTermBorrowings: [[undefined, '2024-12-31', 20]],
      CashAndCashEquivalentsAtCarryingValue: [[undefined, '2024-12-31', 80]],
    },
  },
  {
    accn: 'A-25Q1',
    form: '10-Q',
    filed: '2025-05-01',
    facts: {
      EarningsPerShareDiluted: [
        [...(q25.q1 as [string, string]), -0.5],
        [...(q24.q1 as [string, string]), 1.0],
      ],
      Revenues: [[...(q25.q1 as [string, string]), 90]],
    },
  },
  {
    // The 10-K's revenue restated three months later.
    accn: 'A-24KA',
    form: '10-K/A',
    filed: '2025-05-20',
    facts: { Revenues: [[...(q24.fy as [string, string]), 440]] },
  },
];

describe('point-in-time fundamentals from EDGAR (v1.2 item 6)', () => {
  const obs = pointInTimeObservations(companyFacts(filings));

  it('knows nothing before the first filing was accepted', () => {
    expect(asOf(obs, 'eps_ttm', '2024-12-31T00:00:00Z')).toBeUndefined();
    expect(asOf(obs, 'equity', '2024-05-01T12:00:00Z')).toBeUndefined();
    expect(asOf(obs, 'equity', '2024-05-02T00:00:00Z')).toBe(500);
  });

  it('uses the year that just ended, then the last four quarters (Q4 from the year)', () => {
    expect(asOf(obs, 'eps_ttm', '2025-03-01T00:00:00Z')).toBe(4.6);
    expect(asOf(obs, 'revenue_ttm', '2025-03-01T00:00:00Z')).toBe(460);
    // Q1 2025 + Q2, Q3 (330 − 210) and Q4 (460 − 330) of 2024.
    expect(asOf(obs, 'revenue_ttm', '2025-05-10T00:00:00Z')).toBe(90 + 110 + 120 + 130);
    expect(asOf(obs, 'eps_ttm', '2025-05-10T00:00:00Z')).toBeCloseTo(-0.5 + 1.1 + 1.2 + 1.3, 9);
  });

  it('keeps the value as filed and adds a restatement as a new, later observation', () => {
    const revenue = obs.filter((o) => o.field === 'revenue_ttm');
    expect(revenue.map((o) => [o.value, o.accession])).toEqual([
      ['460', 'A-24K'],
      ['450', 'A-25Q1'],
      // Q4 2024 restated to 110: 90 + 110 + 120 + 110.
      ['430', 'A-24KA'],
    ]);
    expect(asOf(obs, 'revenue_ttm', '2025-05-19T00:00:00Z')).toBe(450);
    expect(asOf(obs, 'revenue_ttm', '2025-05-21T00:00:00Z')).toBe(430);
  });

  it('adds debt and short-term borrowings, and takes cash and shares from the latest date', () => {
    expect(asOf(obs, 'debt', '2025-03-01T00:00:00Z')).toBe(320);
    expect(asOf(obs, 'cash', '2025-03-01T00:00:00Z')).toBe(80);
    expect(asOf(obs, 'shares', '2025-03-01T00:00:00Z')).toBe(1000);
  });

  it('counts a dividend streak from the annual report and gives dividends per share TTM', () => {
    expect(asOf(obs, 'dps_ttm', '2025-03-01T00:00:00Z')).toBe(1.2);
    expect(asOf(obs, 'dividend_streak', '2025-03-01T00:00:00Z')).toBe(1);
  });

  it('drops a value describing a period more than fifteen months old', () => {
    expect(asOf(obs, 'equity', '2025-06-01T00:00:00Z')).toBe(500);
    expect(asOf(obs, 'equity', '2025-07-15T00:00:00Z')).toBeUndefined();
  });

  it('puts earlier per-share values on the new basis after a stock split', () => {
    const split = pointInTimeObservations(
      companyFacts([
        ...filings.slice(0, 5),
        {
          accn: 'A-25Q2',
          form: '10-Q',
          filed: '2025-08-01',
          facts: {
            // 2-for-1 in June: the comparative quarter is restated at half.
            EarningsPerShareDiluted: [
              [...(q25.q2 as [string, string]), 0.6],
              [...(q24.q2 as [string, string]), 0.55],
            ],
            // The cover page shows the doubled share count.
            EntityCommonStockSharesOutstanding: [[undefined, '2025-07-20', 2000]],
          },
        },
      ]),
    );
    // Q2 2025 0.6, Q1 2025 −0.25, Q4 2024 0.65, Q3 2024 0.6, all on today's basis.
    expect(asOf(split, 'eps_ttm', '2025-08-10T00:00:00Z')).toBeCloseTo(0.6 - 0.25 + 0.65 + 0.6, 9);
  });

  it('takes no split from a whole-ratio change the share count does not show', () => {
    const notSplit = pointInTimeObservations(
      companyFacts([
        ...filings.slice(0, 5),
        {
          accn: 'A-25Q2',
          form: '10-Q',
          filed: '2025-08-01',
          facts: {
            EarningsPerShareDiluted: [
              [...(q25.q2 as [string, string]), 1.2],
              [...(q24.q2 as [string, string]), 0.55],
            ],
            EntityCommonStockSharesOutstanding: [[undefined, '2025-07-20', 1010]],
          },
        },
      ]),
    );
    // The restated quarter replaces the old one; nothing else is rescaled.
    expect(asOf(notSplit, 'eps_ttm', '2025-08-10T00:00:00Z')).toBeCloseTo(1.2 - 0.5 + 1.3 + 1.2, 9);
  });

  it('never mistakes dividends paid against dividends declared for a split', () => {
    // Declared each quarter when it is announced; one 10-Q reports only what was paid,
    // which for that quarter was half (the next dividend was declared, not yet paid).
    const div = (accn: string, filed: string, tag: string, rows: [string, string, number][]) => ({
      accn,
      form: '10-Q',
      filed,
      facts: {
        [tag]: rows,
        EntityCommonStockSharesOutstanding: [[undefined, filed, 1000]] as [
          undefined,
          string,
          number,
        ][],
      },
    });
    const D = 'CommonStockDividendsPerShareDeclared';
    const P = 'CommonStockDividendsPerShareCashPaid';
    const obs = pointInTimeObservations(
      companyFacts([
        div('D-0', '2024-02-20', D, [['2023-10-01', '2023-12-31', 0.66]]),
        div('D-1', '2024-05-01', D, [[...(q24.q1 as [string, string]), 0.66]]),
        div('D-2', '2024-08-01', D, [[...(q24.q2 as [string, string]), 0.66]]),
        div('D-3', '2024-11-01', P, [
          [...(q24.q3 as [string, string]), 0.66],
          [...(q24.q2 as [string, string]), 0.33],
        ]),
        div('D-5', '2025-05-01', D, [
          [...(q25.q1 as [string, string]), 0.66],
          [...(q24.q1 as [string, string]), 0.66],
        ]),
      ]),
    );
    // Four quarters of 0.66: the paid figure neither rescales nor replaces the declared ones.
    expect(asOf(obs, 'dps_ttm', '2024-11-10T00:00:00Z')).toBeCloseTo(2.64, 9);
    expect(asOf(obs, 'dps_ttm', '2025-05-10T00:00:00Z')).toBeCloseTo(2.64, 9);
  });
});

describe('a company that pays no dividend (Yong, 2026-11-07)', () => {
  const eps = (accn: string, filed: string, extra: F['facts'] = {}): F => ({
    accn,
    form: '10-Q',
    filed,
    facts: { EarningsPerShareDiluted: [[...(q24.q1 as [string, string]), 1]], ...extra },
  });

  it('has a dividend yield of 0: earnings reported, no dividends at all', () => {
    const obs = pointInTimeObservations(companyFacts([eps('N-1', '2024-05-01')]));
    expect(asOf(obs, 'dps_ttm', '2024-05-02T00:00:00Z')).toBe(0);
  });

  it('stays unknown when it pays cash dividends but reports no per-share figure', () => {
    const obs = pointInTimeObservations(
      companyFacts([
        eps('P-1', '2024-05-01', {
          PaymentsOfDividendsCommonStock: [[...(q24.q1 as [string, string]), 5_000_000]],
        }),
      ]),
    );
    expect(asOf(obs, 'dps_ttm', '2024-05-02T00:00:00Z')).toBeUndefined();
  });

  it("keeps a payer's dividends, and drops to 0 only once none were paid for 15 months", () => {
    const obs = pointInTimeObservations(companyFacts(filings));
    // The 10-K's 1.2 a year stands while it is recent.
    expect(asOf(obs, 'dps_ttm', '2025-03-01T00:00:00Z')).toBe(1.2);
    const later = pointInTimeObservations(
      companyFacts([
        ...filings,
        {
          accn: 'A-26Q2',
          form: '10-Q',
          filed: '2026-08-01',
          facts: { EarningsPerShareDiluted: [['2026-04-01', '2026-06-30', 1]] },
        },
      ]),
    );
    expect(asOf(later, 'dps_ttm', '2026-08-02T00:00:00Z')).toBe(0);
  });
});

describe('gaps in what companies tag (S&P 500 re-test, 2026-11-07)', () => {
  const tenQ = (accn: string, filed: string, facts: F['facts']): F => ({
    accn,
    form: '10-Q',
    filed,
    facts,
  });
  const span = (p: string[]) => p as [string, string];
  const div = 'CommonStockDividendsPerShareDeclared';

  it('fills a fiscal Q4 dividend only the untagged annual report covers (GD, TRV)', () => {
    // Dividends tagged in 10-Qs only: Q4 2024 is never reported.
    const obs = pointInTimeObservations(
      companyFacts([
        tenQ('D-24Q3', '2024-10-20', {
          [div]: [
            [...span(q24.q3), 1.42],
            [...span(q24.m9), 4.26],
          ],
        }),
        tenQ('D-25Q1', '2025-04-20', { [div]: [[...span(q25.q1), 1.5]] }),
        tenQ('D-25Q2', '2025-07-20', {
          [div]: [
            [...span(q25.q2), 1.5],
            [...span(q25.h1), 3],
          ],
        }),
        tenQ('D-25Q3', '2025-10-20', {
          [div]: [
            [...span(q25.q3), 1.5],
            [...span(q25.m9), 4.5],
          ],
        }),
      ]),
    );
    // Q4 2024 takes Q3 2024's 1.42: 1.42 + 3 × 1.5.
    expect(asOf(obs, 'dps_ttm', '2025-10-21T00:00:00Z')).toBeCloseTo(5.92);
  });

  it('never guesses a missing quarter of earnings', () => {
    const obs = pointInTimeObservations(
      companyFacts([
        tenQ('E-24Q3', '2024-10-20', { EarningsPerShareDiluted: [[...span(q24.q3), 1]] }),
        tenQ('E-25Q1', '2025-04-20', { EarningsPerShareDiluted: [[...span(q25.q1), 1]] }),
        tenQ('E-25Q2', '2025-07-20', { EarningsPerShareDiluted: [[...span(q25.q2), 1]] }),
        tenQ('E-25Q3', '2025-10-20', { EarningsPerShareDiluted: [[...span(q25.q3), 1]] }),
      ]),
    );
    expect(asOf(obs, 'eps_ttm', '2025-10-21T00:00:00Z')).toBeUndefined();
  });

  it('adds up dividends tagged by payment date, counting a re-dated repeat once (DIS)', () => {
    const paid = 'CommonStockDividendsPerShareCashPaid';
    const obs = pointInTimeObservations(
      companyFacts([
        tenQ('P-1', '2025-02-05', {
          [paid]: [
            [undefined, '2024-01-10', 0.3],
            [undefined, '2024-07-25', 0.45],
          ],
        }),
        // The annual report dates the same payments a few days later.
        {
          accn: 'P-2',
          form: '10-K',
          filed: '2025-03-01',
          facts: {
            [paid]: [
              [undefined, '2024-07-31', 0.45],
              [undefined, '2025-01-16', 0.5],
            ],
          },
        },
        tenQ('P-3', '2025-08-06', { [paid]: [[undefined, '2025-07-23', 0.5]] }),
      ]),
    );
    expect(asOf(obs, 'dps_ttm', '2025-02-06T00:00:00Z')).toBe(0.75);
    expect(asOf(obs, 'dps_ttm', '2025-03-02T00:00:00Z')).toBe(0.95);
    expect(asOf(obs, 'dps_ttm', '2025-08-07T00:00:00Z')).toBe(1);
  });

  it('never steps back to an older period a later filing still allows (DIS)', () => {
    const paid = 'CommonStockDividendsPerShareCashPaid';
    const obs = pointInTimeObservations(
      companyFacts([
        {
          accn: 'S-1',
          form: '10-K',
          filed: '2020-11-20',
          facts: { [paid]: [[...span(Q(2019).fy), 3.52]] },
        },
        tenQ('S-2', '2025-08-06', {
          [paid]: [
            [undefined, '2025-01-16', 0.5],
            [undefined, '2025-07-23', 0.5],
          ],
        }),
        // A later filing repeating the old year must not bring back 3.52.
        {
          accn: 'S-3',
          form: '10-K',
          filed: '2025-11-13',
          facts: { [paid]: [[...span(Q(2019).fy), 3.52]] },
        },
      ]),
    );
    expect(asOf(obs, 'dps_ttm', '2025-11-14T00:00:00Z')).toBe(1);
  });

  it("takes the balance sheet's share count when the cover page gives none (EL)", () => {
    const obs = pointInTimeObservations(
      companyFacts([
        tenQ('L-1', '2025-05-01', {
          CommonStockSharesOutstanding: [[undefined, '2025-03-31', 360]],
        }),
      ]),
    );
    expect(asOf(obs, 'shares', '2025-05-02T00:00:00Z')).toBe(360);
  });

  it('works out EPS from net income and the share count when quarters tag no EPS (GD)', () => {
    const ni = 'NetIncomeLoss';
    const shares = 'EntityCommonStockSharesOutstanding';
    const obs = pointInTimeObservations(
      companyFacts([
        {
          accn: 'G-24K',
          form: '10-K',
          filed: '2025-02-07',
          facts: {
            EarningsPerShareDiluted: [[...span(q24.fy), 13.63]],
            [ni]: [
              [...span(q24.q1), 800],
              [...span(q24.h1), 1700],
              [...span(q24.m9), 2700],
              [...span(q24.fy), 3782],
            ],
            [shares]: [[undefined, '2025-01-20', 275]],
          },
        },
        tenQ('G-25Q1', '2025-04-23', {
          [ni]: [[...span(q25.q1), 1000]],
          [shares]: [[undefined, '2025-04-15', 270]],
        }),
        tenQ('G-25Q2', '2025-07-23', {
          [ni]: [[...span(q25.h1), 2000]],
          [shares]: [[undefined, '2025-07-15', 270]],
        }),
      ]),
    );
    expect(asOf(obs, 'eps_ttm', '2025-02-08T00:00:00Z')).toBe(13.63);
    // Net income TTM to June 2025: 1000 (Q3 2024) + 1082 (Q4) + 2000 = 4082, over 270 shares.
    expect(asOf(obs, 'eps_ttm', '2025-07-24T00:00:00Z')).toBeCloseTo(4082 / 270);
  });
});

describe('acceptance times', () => {
  it('reads EDGAR acceptance times as New York wall time', () => {
    const sub = {
      filings: {
        recent: {
          accessionNumber: ['a', 'b', 'c'],
          acceptanceDateTime: ['2025-10-31T06:01:26.000Z', '2025-01-30T16:30:00.000Z', ''],
        },
      },
    } as unknown as SecSubmissions;
    const times = acceptanceTimes(sub);
    expect(times.get('a')).toBe('2025-10-31T10:01:26.000Z');
    expect(times.get('b')).toBe('2025-01-30T21:30:00.000Z');
    expect(times.has('c')).toBe(false);
  });

  it('uses 17:30 New York on the filing date when the acceptance time is unknown', () => {
    expect(filedDateAvailability('2025-02-20')).toBe('2025-02-20T22:30:00.000Z');
    expect(filedDateAvailability('2025-07-01')).toBe('2025-07-01T21:30:00.000Z');
  });

  it('makes a filing visible from its acceptance time', () => {
    const obs = pointInTimeObservations(
      companyFacts(filings.slice(0, 1)),
      new Map([['A-24Q1', '2024-04-30T20:05:00.000Z']]),
    );
    expect(obs.every((o) => o.availableFrom === '2024-04-30T20:05:00.000Z')).toBe(true);
  });
});

describe('point-in-time fundamentals from the fake EDGAR', () => {
  it('replays the fake companies with acceptance times, dividends and a streak', async () => {
    const { FakeSec, FAKE_SEC_DATA_URL, FAKE_SEC_WWW_URL } = await import('./testing');
    const { SecClient } = await import('./client');
    const { fetchPointInTime } = await import('./point-in-time');
    const now = new Date('2026-11-05T15:00:00Z');
    const fake = new FakeSec({ now: () => now });
    const client = new SecClient({
      credentials: { contactEmail: 'yong@example.com' },
      fetch: fake.fetch,
      wwwUrl: FAKE_SEC_WWW_URL,
      dataUrl: FAKE_SEC_DATA_URL,
      allowLocal: true,
      spacingMs: 0,
    });
    const beta = await fetchPointInTime(client, 9_900_002);
    const at = now.getTime();
    expect(latestObservation(beta, 'dps_ttm', at)?.value.toNumber()).toBeGreaterThan(2.5);
    expect(latestObservation(beta, 'dividend_streak', at)?.value.toNumber()).toBe(4);
    expect(latestObservation(beta, 'eps_ttm', at)?.value.toNumber()).toBeGreaterThan(0);
    expect(latestObservation(beta, 'ebitda_ttm', at)).toBeDefined();
    // Accepted at 16:05 New York time on the filing date.
    expect(beta?.every((o) => /T2[01]:05:00\.000Z$/.test(o.availableFrom))).toBe(true);
    const alpha = await fetchPointInTime(client, 9_900_001);
    // A non-payer's dividends per share are 0, so its yield is 0% (Yong, 2026-11-07).
    expect(latestObservation(alpha, 'dps_ttm', at)?.value.toNumber()).toBe(0);
    expect(await fetchPointInTime(client, 1234)).toBeUndefined();
  });
});

describe('cash flow (pattern brief §4: FCF margin)', () => {
  // Cash flow statements report year to date: 3, 6, 9 and 12 months.
  const ytd = (
    accn: string,
    form: string,
    filed: string,
    end: string,
    ocf: number,
    capex: number,
  ) => ({
    accn,
    form,
    filed,
    facts: {
      NetCashProvidedByUsedInOperatingActivities: [['2024-01-01', end, ocf]],
      PaymentsToAcquirePropertyPlantAndEquipment: [['2024-01-01', end, capex]],
    } as F['facts'],
  });
  const cash: F[] = [
    ytd('C-Q1', '10-Q', '2024-05-01', '2024-03-31', 30, 5),
    ytd('C-Q2', '10-Q', '2024-08-01', '2024-06-30', 70, 12),
    ytd('C-Q3', '10-Q', '2024-11-01', '2024-09-30', 100, 20),
    ytd('C-FY', '10-K', '2025-02-15', '2024-12-31', 150, 30),
    {
      accn: 'C-25Q1',
      form: '10-Q',
      filed: '2025-05-01',
      facts: {
        NetCashProvidedByUsedInOperatingActivities: [['2025-01-01', '2025-03-31', 40]],
        PaymentsToAcquirePropertyPlantAndEquipment: [['2025-01-01', '2025-03-31', 6]],
      },
    },
  ];
  const obs = pointInTimeObservations(companyFacts(cash));
  it('is the fiscal year when one just ended, else four quarters from the YTD chain', () => {
    expect(asOf(obs, 'ocf_ttm', '2024-12-01')).toBeUndefined();
    expect(asOf(obs, 'ocf_ttm', '2025-03-01')).toBe(150);
    expect(asOf(obs, 'capex_ttm', '2025-03-01')).toBe(30);
    // Q2–Q4 2024 (40 + 30 + 50) plus Q1 2025 (40).
    expect(asOf(obs, 'ocf_ttm', '2025-05-02')).toBe(160);
    expect(asOf(obs, 'capex_ttm', '2025-05-02')).toBe(31);
  });
});
