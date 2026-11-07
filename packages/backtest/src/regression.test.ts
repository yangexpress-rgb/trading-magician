import { describe, expect, it } from 'vitest';
import { simulate } from './engine';
import {
  breakoutDonchian,
  meanReversionRsi2,
  QQQ,
  SPY,
  spyBars,
  trendSma200,
  twoLegs,
} from './fixtures/spy-strategies';
import { behaviour } from './corpus-codec';
import { inputs, loaded } from './test-utils';

/**
 * Backward compatibility for v1.2 (design principle 5): the three SPY
 * strategies, and a plain two-leg strategy, back test exactly as they did
 * before the v1.2 builder changes.
 *
 * Until the Strategy Lab simplification (ADR 0049) the hashes covered every
 * result field that existed on main at 8b7b954 (Trend ce55c3003c6656e6,
 * RSI-2 b0249e656b2ea41a, Donchian 144e139a4cd26fe7, two legs
 * a3a795f07ec79345). The results echo the strategy's trigger settings, whose
 * shape schema 2 changes (a cooldown in bars), so the hashes are now the
 * behaviour fingerprint (corpus-codec.ts): every decision, order, fill,
 * trade, equity point, metric and warning. These values were taken on main
 * 5bc70be, before the simplification; corpus.test.ts replays the stored
 * schema 1 forms of the same strategies too.
 */
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
    ['Trend — SPY SMA200', trendSma200, '359f3c8d617a2e6e trades=7'],
    ['Mean Reversion — SPY RSI-2', meanReversionRsi2, '28a9842e5ab84767 trades=15'],
    ['Breakout — SPY Donchian 20/10', breakoutDonchian, 'c4e0ad1ba4caff45 trades=0'],
    ['Two legs, no leg conditions', twoLegs, '0199ca63e0450e45 trades=7'],
  ] as const)('%s', (_name, build, golden) => {
    const r = run(build());
    expect(`${behaviour(r)} trades=${r.trades.length}`).toBe(golden);
  });
});
