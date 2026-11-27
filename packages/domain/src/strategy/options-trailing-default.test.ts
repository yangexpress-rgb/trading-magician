import { describe, expect, it } from 'vitest';
import { optionsTrailingStopDefault } from './options-trailing-default';
import type { StrategyDefinition } from './schema';
import { order, validDefinition } from './test-fixtures';

/** O231 (2026-11-27): options strategies start with the strategy trailing stop off. */

const withOptionLeg = (def: StrategyDefinition): StrategyDefinition => ({
  ...def,
  entry: {
    ...def.entry,
    orders: [
      order('call', {
        option: {
          right: 'call',
          strikeRule: { type: 'atm' },
          expiryRule: { targetDte: 30, minDte: 7 },
        },
      }),
    ],
  },
});

describe('the options trailing-stop default (O231)', () => {
  it('turns the untouched 1% default off when the first options leg arrives', () => {
    const before = validDefinition();
    expect(before.risk.trailingStopPct).toBe('1');
    const next = optionsTrailingStopDefault(before, withOptionLeg(before));
    expect(next.risk.trailingStopPct).toBeUndefined();
  });
  it('does the same for a strategy created with options legs', () => {
    const next = optionsTrailingStopDefault(undefined, withOptionLeg(validDefinition()));
    expect(next.risk.trailingStopPct).toBeUndefined();
  });
  it('never overrides a value the user set, even 1%', () => {
    const before = validDefinition();
    before.risk = { ...before.risk, trailingStopPct: '1', trailingStopSet: true };
    expect(optionsTrailingStopDefault(before, withOptionLeg(before)).risk.trailingStopPct).toBe(
      '1',
    );
    before.risk = { ...before.risk, trailingStopPct: '30' };
    const kept = optionsTrailingStopDefault(before, withOptionLeg(before));
    expect(kept.risk.trailingStopPct).toBe('30');
  });
  it('leaves a value other than the default alone', () => {
    const before = validDefinition();
    before.risk = { ...before.risk, trailingStopPct: '40' };
    expect(optionsTrailingStopDefault(before, withOptionLeg(before)).risk.trailingStopPct).toBe(
      '40',
    );
  });
  it('acts only on the change that adds the first options leg', () => {
    // Already an options strategy: a 1% the user typed back in later stays.
    const before = withOptionLeg(validDefinition());
    before.risk = { ...before.risk, trailingStopPct: undefined };
    const after = { ...before, risk: { ...before.risk, trailingStopPct: '1' } };
    expect(optionsTrailingStopDefault(before, after).risk.trailingStopPct).toBe('1');
  });
  it('leaves stock and ETF strategies unchanged', () => {
    const def = validDefinition();
    expect(optionsTrailingStopDefault(undefined, def)).toBe(def);
    expect(optionsTrailingStopDefault(def, def)).toBe(def);
  });
});
