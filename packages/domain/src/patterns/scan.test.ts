import { describe, expect, it } from 'vitest';
import {
  eventStudy,
  hitRateWords,
  outcomeShort,
  patternChip,
  patternScanInputSchema,
  promotedName,
  ruleWords,
  scanSummary,
  type PatternAtom,
} from './scan';

const rule: PatternAtom[] = [
  { factor: 'return_21d', mode: 'cross', bucket: 'top' },
  { factor: 'volume_ratio_60', mode: 'own', bucket: 'high' },
];

describe('pattern scan words', () => {
  it('applies the brief defaults and summarises the scan', () => {
    const input = patternScanInputSchema.parse({
      universe: { kind: 'group', id: 'sp500' },
      outcome: { direction: 'plunge', pct: 8, horizon: 15 },
      categories: ['price', 'fundamentals'],
    });
    expect(input).toMatchObject({
      maxDepth: 3,
      minSupport: 40,
      split: { discovery: 0.7 },
      range: {},
    });
    expect(outcomeShort(input.outcome)).toBe('Plunge −8% / 15d');
    expect(scanSummary(input)).toContain('full available range');
  });

  it('says a rule in plain words', () => {
    expect(ruleWords(rule)).toMatch(
      /^When .+ top quintile of the universe AND .+ 90th percentile of its own past year$/,
    );
    expect(promotedName(rule, 60).length).toBeLessThanOrEqual(60);
  });

  it('shows the decay state once scored', () => {
    expect(patternChip('candidate', null)).toBe('Candidate');
    expect(patternChip('verified', null)).toBe('Verified');
    expect(patternChip('verified', 'broken')).toBe('Broken');
    expect(hitRateWords({ n: 55, hits: 41, rate: 41 / 55 })).toBe('41 of 55 (75%)');
  });
});

describe('event study', () => {
  it('compounds daily returns from the occurrence close, both ways', () => {
    const path = {
      returns: new Map([
        [0, 0.1],
        [1, 0.1],
        [2, -0.5],
      ]),
    };
    const points = eventStudy([path], 1, 2);
    expect(points.map((p) => p.offset)).toEqual([-1, 0, 1, 2]);
    expect(points[0]!.mean).toBeCloseTo(1 / 1.1 - 1);
    expect(points[1]!.mean).toBe(0);
    expect(points[2]!.mean).toBeCloseTo(0.1);
    expect(points[3]!.mean).toBeCloseTo(1.1 * 0.5 - 1);
  });

  it('drops an occurrence from offsets past a gap', () => {
    const full = {
      returns: new Map([
        [1, 0.02],
        [2, 0.02],
      ]),
    };
    const gap = { returns: new Map([[1, 0.04]]) };
    const [, , one, two] = eventStudy([full, gap], 1, 2);
    expect(one!.n).toBe(2);
    expect(one!.mean).toBeCloseTo(0.03);
    expect(two!.n).toBe(1);
  });
});
