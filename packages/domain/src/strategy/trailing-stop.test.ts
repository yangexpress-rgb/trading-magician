import { describe, expect, it } from 'vitest';
import { parseDefinition } from './serialize';
import { definitionSeries, planSlots } from './selection';
import { context, STOCK_A, validDefinition } from './test-fixtures';
import { trailingStopCloses } from './trailing-stop';
import { validateStrategy } from './validate';

/** The trailing stop and Selection groups that keep their picks (ADR 0059). */

function withRule(percent = '1') {
  const def = validDefinition();
  def.exit.rules = [{ kind: 'trailingStop', id: 'ts', percent }];
  return def;
}

describe('the trailing stop rule', () => {
  it('parses, and reads the first Entry leg’s daily closes', () => {
    const def = parseDefinition(withRule());
    expect(trailingStopCloses(def)).toEqual([
      expect.objectContaining({ field: 'close', interval: '1d', instrumentId: STOCK_A }),
    ]);
    expect(definitionSeries(def).some((s) => s.instrumentId === STOCK_A)).toBe(true);
    expect(validateStrategy(def, context()).errors).toEqual([]);
  });

  it('allows one per Exit, and a percent above 0 and below 100', () => {
    const def = withRule();
    def.exit.rules = [...def.exit.rules!, { ...def.exit.rules![0]!, id: 'ts2' }];
    expect(validateStrategy(def, context()).errors.map((e) => e.code)).toEqual([
      'duplicate_trailing_stop',
    ]);
    expect(() => parseDefinition(withRule('0'))).toThrow();
    expect(() => parseDefinition(withRule('100'))).toThrow();
    expect(() => parseDefinition(withRule('0.5'))).not.toThrow();
  });
});

describe('a Selection group that keeps its picks', () => {
  const slot = (instrumentId: string) => ({ legId: 'leg', instrumentId });
  const held = [{ key: 'leg|A', id: 'c1', open: true }];
  it('sells nothing at a rebalance, and still enters new picks', () => {
    const base = {
      mode: 'selection' as const,
      scheduled: false,
      candidates: [slot('B')],
      held,
      halted: false,
    };
    const sells = planSlots(base);
    const keeps = planSlots({ ...base, keepHoldings: true });
    expect(sells.exit).toEqual(['c1']);
    expect(keeps.exit).toEqual([]);
    expect(keeps.enter).toEqual([slot('B')]);
  });
});
