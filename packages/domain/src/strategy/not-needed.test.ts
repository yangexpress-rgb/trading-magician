import { describe, expect, it } from 'vitest';
import { evaluateComparison, type SeriesResolver } from './evaluate';
import { isYesNoExpr } from './metrics';
import type { MetricExpr } from './schema';
import { parseDefinition } from './serialize';
import { comparison, constant, context, STOCK_A, validDefinition } from './test-fixtures';
import { describeCondition } from './text';
import { validateStrategy } from './validate';

/** "Not needed" (N216): a yes/no metric such as Earnings window needs nothing to compare with. */

const window = (): MetricExpr => ({
  kind: 'metric',
  id: 'ew',
  metric: 'earnings.window',
  params: { fromDay: -1, toDay: 1 },
  instrumentId: STOCK_A,
});

const resolver: SeriesResolver = { value: () => undefined, isStale: () => false };

describe('the "Not needed" comparison', () => {
  it('holds when the left side says yes, fails on no, and is unknown without data', () => {
    expect(evaluateComparison(comparison('y', constant('1'), 'is_true'), resolver)).toBe(true);
    expect(evaluateComparison(comparison('n', constant('0'), 'is_true'), resolver)).toBe(false);
    expect(
      evaluateComparison(comparison('u', window(), 'is_true'), {
        ...resolver,
        event: () => undefined,
      }),
    ).toBeUndefined();
  });

  it('is only for yes/no metrics', () => {
    expect(isYesNoExpr(window())).toBe(true);
    expect(isYesNoExpr({ ...window(), metric: 'return', params: {} })).toBe(false);
    expect(isYesNoExpr(constant('1'))).toBe(false);
    const def = validDefinition();
    def.entry.condition.children = [comparison('ok', window(), 'is_true')];
    expect(validateStrategy(def, context()).errors.map((e) => e.code)).not.toContain(
      'not_needed_needs_yes_no',
    );
    def.entry.condition.children = [comparison('bad', constant('3'), 'is_true')];
    expect(validateStrategy(def, context()).errors.map((e) => e.code)).toContain(
      'not_needed_needs_yes_no',
    );
  });

  it('saves with no right side and reads as "holds"', () => {
    const def = validDefinition();
    const c = comparison('ok', window(), 'is_true');
    def.entry.condition.children = [c];
    const back = parseDefinition(JSON.parse(JSON.stringify(def)));
    expect(back.entry.condition.children[0]).toEqual(c);
    expect(describeCondition(c, () => 'XYZ')).toMatch(/Earnings window.* holds$/);
  });
});
