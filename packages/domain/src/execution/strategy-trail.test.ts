import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { migrateV5 } from '../strategy/migrate-v5';
import { parseDefinition } from '../strategy/serialize';
import { validDefinition } from '../strategy/test-fixtures';
import { stepStrategyTrail, strategyTrailText, type StrategyTrailState } from './strategy-trail';

const d = (v: Decimal.Value) => new Decimal(v);

/** Runs the stop over equity / gross pairs and says where it fired. */
function run(limitPct: string | undefined, steps: [equity: number, gross: number][]) {
  let state: StrategyTrailState | undefined;
  const fired: number[] = [];
  steps.forEach(([equity, gross], i) => {
    const r = stepStrategyTrail({
      limitPct,
      state,
      equity: d(equity),
      gross: d(gross),
      holding: gross > 0,
      now: i,
    });
    state = r.state;
    if (r.fired) fired.push(i);
  });
  return { fired, state };
}

describe('strategy trailing stop (N290, ADR 0099)', () => {
  it('fires when equity falls more than the % of the money in positions below its best', () => {
    // $10,000 in one stock: best +$500, then gives back $105 (> 1% of $10,500 held at best).
    const { fired } = run('1', [
      [100_000, 10_000],
      [100_500, 10_500],
      [100_400, 10_400],
      [100_394, 10_394],
    ]);
    expect(fired).toEqual([3]);
  });

  it('holds while the drop stays within the limit', () => {
    const { fired } = run('1', [
      [100_000, 10_000],
      [100_200, 10_200],
      [100_100, 10_100],
    ]);
    expect(fired).toEqual([]);
  });

  it('does not treat buying more as a gain (equity is unchanged by a purchase)', () => {
    const { fired, state } = run('1', [
      [100_000, 10_000],
      [100_000, 20_000],
      [99_850, 19_850],
    ]);
    // $150 below the best, with $20,000 invested: 0.75%, so no stop.
    expect(fired).toEqual([]);
    expect(state?.invested).toBe('20000');
  });

  it('starts afresh once the strategy is flat', () => {
    const { fired, state } = run('1', [
      [100_000, 10_000],
      [100_900, 0],
      [100_900, 10_000],
      [100_850, 9_950],
    ]);
    expect(fired).toEqual([]);
    expect(state?.bestEquity).toBe('100900');
  });

  it('stays fired until flat and is off without a limit', () => {
    let r = stepStrategyTrail({
      limitPct: '1',
      state: { bestEquity: '100000', invested: '10000' },
      equity: d(99_800),
      gross: d(9_800),
      holding: true,
      now: 5,
    });
    expect(r.fired).toBe(true);
    r = stepStrategyTrail({
      limitPct: '1',
      state: r.state,
      equity: d(101_000),
      gross: d(11_000),
      holding: true,
      now: 6,
    });
    expect(r).toMatchObject({ fired: false, closing: true });
    expect(
      run(undefined, [
        [100_000, 10_000],
        [90_000, 1_000],
      ]).fired,
    ).toEqual([]);
  });

  it('explains itself in dollars', () => {
    expect(
      strategyTrailText('1', { bestEquity: '100500', invested: '10500', firedEquity: '100380' }),
    ).toBe(
      'The strategy fell $120.00 below its best since entry, more than 1% of the $10,500.00 in its positions ($105.00), so every position was closed.',
    );
  });
});

describe('schema 5 → 6: existing strategies get the 1% trailing stop', () => {
  it('adds 1% where the limit is missing and leaves a set one alone', () => {
    const v5 = { ...JSON.parse(JSON.stringify(validDefinition())), schemaVersion: 5 };
    delete v5.risk.trailingStopPct;
    expect(parseDefinition(v5).risk.trailingStopPct).toBe('1');
    expect(migrateV5(v5).notes.map((n) => n.code)).toEqual(['strategy_trailing_stop']);
    const set = { ...v5, risk: { ...v5.risk, trailingStopPct: '2.5' } };
    expect(parseDefinition(set).risk.trailingStopPct).toBe('2.5');
  });

  it('keeps a schema 6 strategy saved without the limit off', () => {
    const v6 = JSON.parse(JSON.stringify(validDefinition()));
    delete v6.risk.trailingStopPct;
    expect(parseDefinition(v6).risk.trailingStopPct).toBeUndefined();
  });
});
