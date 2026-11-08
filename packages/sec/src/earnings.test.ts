import { describe, expect, it } from 'vitest';
import { earningsReleaseFilings, quarterlyEps, releaseSue } from './earnings';
import type { SecCompanyFacts, SecFact } from './types';

/** Quarterly EPS from company facts (free data feeds brief v1 §5.2). */

const q = (start: string, end: string, val: number, filed: string, form = '10-Q'): SecFact => ({
  start,
  end,
  val,
  accn: `a-${end}-${filed}`,
  fy: Number(end.slice(0, 4)),
  fp: 'Q',
  form,
  filed,
});

function facts(values: SecFact[]): SecCompanyFacts {
  return {
    cik: 1,
    entityName: 'XYZ Corp',
    facts: {
      'us-gaap': {
        EarningsPerShareDiluted: { label: null, description: null, units: { 'USD/shares': values } },
      },
    },
  };
}

describe('quarterlyEps', () => {
  it('derives the fourth quarter from the year less three quarters', () => {
    const series = quarterlyEps(
      facts([
        q('2025-01-01', '2025-03-31', 1.0, '2025-05-01'),
        q('2025-04-01', '2025-06-30', 1.1, '2025-08-01'),
        q('2025-07-01', '2025-09-30', 1.2, '2025-11-01'),
        q('2025-01-01', '2025-12-31', 4.8, '2026-02-15', '10-K'),
      ]),
    );
    expect(series.map((s) => [s.quarterEnd, s.eps, s.derived])).toEqual([
      ['2025-03-31', 1.0, false],
      ['2025-06-30', 1.1, false],
      ['2025-09-30', 1.2, false],
      ['2025-12-31', 1.5, true],
    ]);
  });

  it('is point in time: a restated comparative counts only from its filing', () => {
    const values = [
      q('2025-01-01', '2025-03-31', 2.0, '2025-05-01'),
      // After a 2-for-1 split, the next year's 10-Q restates the comparative.
      q('2025-01-01', '2025-03-31', 1.0, '2026-05-01'),
    ];
    expect(quarterlyEps(facts(values), '2025-12-31')[0]?.eps).toBe(2.0);
    expect(quarterlyEps(facts(values))[0]?.eps).toBe(1.0);
  });
});

describe('releaseSue', () => {
  it('works out the §7.1 fixture from filed EPS', () => {
    // Quarters 2023-09 … 2026-09: year-on-year differences 0.10 ×4, 0.30 ×4, then 0.25.
    const ends = [
      '2023-09-30', '2023-12-31', '2024-03-31', '2024-06-30',
      '2024-09-30', '2024-12-31', '2025-03-31', '2025-06-30',
      '2025-09-30', '2025-12-31', '2026-03-31', '2026-06-30', '2026-09-30',
    ];
    // XYZ: 2.25 a year ago, 2.50 now; the 8 prior year-on-year differences are 0.10 ×4, 0.30 ×4.
    const values = [1.85, 1.85, 1.85, 1.85, 1.95, 1.95, 1.95, 1.95, 2.25, 2.25, 2.25, 2.25, 2.5];
    const series = ends.map((end, i) =>
      q(
        new Date(Date.parse(end) - 90 * 86_400_000).toISOString().slice(0, 10),
        end,
        values[i] as number,
        new Date(Date.parse(end) + 30 * 86_400_000).toISOString().slice(0, 10),
      ),
    );
    const r = releaseSue(facts(series), '2026-09-30');
    expect(r?.eps).toBe(2.5);
    expect(r?.result).toEqual({ epsQ: 2.5, epsQMinus4: 2.25, diffSd: 0.1, sue: 2.5 });
  });
});

describe('earningsReleaseFilings', () => {
  it('keeps 8-Ks with Item 2.02 only', () => {
    const base = {
      filingDate: '2026-10-30',
      acceptedAt: '2026-10-30T20:30:00.000Z',
      timeKnown: true,
      primaryDocument: 'x.htm',
      url: 'u',
    };
    const out = earningsReleaseFilings([
      { ...base, accession: '1', form: '8-K', items: ['2.02', '9.01'] },
      { ...base, accession: '2', form: '8-K', items: ['5.02'] },
      { ...base, accession: '3', form: '8-K/A', items: ['2.02'] },
      { ...base, accession: '4', form: '10-Q', items: [] },
    ]);
    expect(out.map((f) => f.accession)).toEqual(['1']);
  });
});
