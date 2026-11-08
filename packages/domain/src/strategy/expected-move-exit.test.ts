import { describe, expect, it } from 'vitest';
import { expectedMoveExprs } from './expected-move-exit';
import { parseDefinition } from './serialize';
import { definitionSeries, optionInstruments, usesOptions } from './selection';
import { context, STOCK_A, validDefinition } from './test-fixtures';
import { validateStrategy } from './validate';

/** The expected-move exit rule (options brief v2 §10 item 10, ADR 0053). */

function withRule() {
  const def = validDefinition();
  def.exit.rules = [{ kind: 'expectedMove', id: 'em', horizon: 5, multiple: '1', side: 'either' }];
  return def;
}

describe('the expected-move exit rule', () => {
  it('parses, and reads the first Entry leg’s expected move', () => {
    const def = parseDefinition(withRule());
    expect(expectedMoveExprs(def)).toEqual([
      expect.objectContaining({ metric: 'options.expected_move_5d_pct', instrumentId: STOCK_A }),
    ]);
    expect(usesOptions(def)).toBe(true);
    expect(optionInstruments(def)).toEqual([STOCK_A]);
    expect(definitionSeries(def).some((s) => s.instrumentId === STOCK_A)).toBe(true);
  });

  it('needs the options feed, and only one per Exit', () => {
    const def = withRule();
    expect(validateStrategy(def, context()).errors.map((e) => e.code)).toContain(
      'missing_options_feed',
    );
    def.exit.rules = [...def.exit.rules!, { ...def.exit.rules![0]!, id: 'em2' }];
    const ok = context({ options: { feedOn: true, universe: new Set([STOCK_A]) } });
    expect(validateStrategy(def, ok).errors.map((e) => e.code)).toEqual([
      'duplicate_expected_move_exit',
    ]);
  });

  it('refuses a multiple that is not positive', () => {
    const def = withRule();
    def.exit.rules = [{ kind: 'expectedMove', id: 'em', horizon: 5, multiple: '0', side: 'gain' }];
    expect(() => parseDefinition(def)).toThrow();
  });
});
