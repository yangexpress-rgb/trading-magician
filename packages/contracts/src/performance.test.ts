import { describe, expect, it } from 'vitest';
import { performanceQuery } from './performance';

const id = '0b6f7a52-6a1e-4a43-9c2b-6c1c1c3e2f10';
const other = '7d4c3a1e-2b9f-4f0e-8a6d-5e4f3c2b1a09';

describe('performanceQuery', () => {
  it('defaults to paper and takes one or several of each filter', () => {
    expect(performanceQuery.parse({})).toEqual({ mode: 'paper' });
    expect(
      performanceQuery.parse({ accountId: id, strategyId: [id, other], assetClass: 'etf' }),
    ).toEqual({ mode: 'paper', accountId: [id], strategyId: [id, other], assetClass: ['etf'] });
  });

  it('rejects bad ids, dates, classes and a range that ends before it starts', () => {
    expect(performanceQuery.safeParse({ accountId: 'nope' }).success).toBe(false);
    expect(performanceQuery.safeParse({ from: '2026-13-01' }).success).toBe(false);
    expect(performanceQuery.safeParse({ assetClass: 'bonds' }).success).toBe(false);
    expect(performanceQuery.safeParse({ from: '2026-10-07', to: '2026-10-06' }).success).toBe(
      false,
    );
    expect(performanceQuery.safeParse({ from: '2026-10-06', to: '2026-10-06' }).success).toBe(true);
  });
});
