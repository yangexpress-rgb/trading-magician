import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { simulate } from './engine';
import type { BacktestResult } from './results';
import {
  breakoutDonchian,
  meanReversionRsi2,
  QQQ,
  SPY,
  spyBars,
  trendSma200,
  twoLegs,
} from './fixtures/spy-strategies';
import { inputs, loaded } from './test-utils';

/**
 * Backward compatibility for v1.2 (design principle 5): the three SPY
 * strategies, and a plain two-leg strategy, back test exactly as they did
 * before the v1.2 builder changes. The hashes were taken on main at 8b7b954,
 * before any v1.2 code, over every result field that existed then.
 */
const V11_FIELDS = [
  'conditions',
  'orders',
  'symbols',
  'engineVersion',
  'dataVersions',
  'assumptions',
  'sharpeMethod',
  'metrics',
  'equity',
  'trades',
  'fills',
  'contributions',
  'warnings',
] as const;

export function fingerprint(r: BacktestResult): string {
  const picked = Object.fromEntries(V11_FIELDS.map((k) => [k, r[k]]));
  return createHash('sha256').update(JSON.stringify(picked)).digest('hex').slice(0, 16);
}

const INSTRUMENTS = new Map([
  [SPY, { symbol: 'SPY', assetClass: 'etf', lotSize: '1' }],
  [QQQ, { symbol: 'QQQ', assetClass: 'etf', lotSize: '1' }],
]);
const run = (definition: ReturnType<typeof trendSma200>) =>
  simulate({
    definition,
    instruments: INSTRUMENTS,
    inputs: inputs('2023-11-01', '2025-06-30'),
    data: loaded({ [SPY]: spyBars(), [QQQ]: spyBars(640, 11) }),
  });

describe('v1.1 strategies back test exactly as before (regression)', () => {
  it.each([
    ['Trend — SPY SMA200', trendSma200, 'ce55c3003c6656e6 trades=7'],
    ['Mean Reversion — SPY RSI-2', meanReversionRsi2, 'b0249e656b2ea41a trades=15'],
    ['Breakout — SPY Donchian 20/10', breakoutDonchian, '144e139a4cd26fe7 trades=0'],
    ['Two legs, no leg conditions', twoLegs, 'a3a795f07ec79345 trades=7'],
  ] as const)('%s', (_name, build, golden) => {
    const r = run(build());
    expect(`${fingerprint(r)} trades=${r.trades.length}`).toBe(golden);
  });
});
