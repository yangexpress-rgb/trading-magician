import { describe, expect, it } from 'vitest';
import { parseDefinition } from './serialize';
import type { PlannedOrder, StrategyDefinition } from './schema';
import { context, validDefinition } from './test-fixtures';
import { validateStrategy } from './validate';
import { hasOptionLegs } from './validate-options';

/** Options legs at validation (options brief v0.2 §5.1, ADR 0123). */
const opt: NonNullable<PlannedOrder['option']> = {
  right: 'call',
  strikeRule: { type: 'atm' },
  expiryRule: { targetDte: 30, minDte: 7 },
};

function withOption(): StrategyDefinition {
  const def = validDefinition();
  def.entry.orders[0] = { ...def.entry.orders[0]!, option: opt };
  return def;
}

const codes = (def: StrategyDefinition, ctx = context()) => {
  const v = validateStrategy(def, ctx);
  return v.errors.map((e) => e.code);
};

describe('options legs (ADR 0123)', () => {
  it('leave a stock strategy exactly as it was', () => {
    const def = validDefinition();
    expect(hasOptionLegs(def)).toBe(false);
    expect(validateStrategy(def, { ...context(), optionsTradingEnabled: true })).toEqual(
      validateStrategy(def, context()),
    );
  });
  it('parse with the optional field and survive a round trip', () => {
    const def = parseDefinition(withOption());
    expect(def.entry.orders[0]?.option).toEqual(opt);
    expect(hasOptionLegs(def)).toBe(true);
  });
  it('fail with a plain reason while the switch is off', () => {
    expect(codes(withOption())).toContain('options_off');
    const v = validateStrategy(withOption(), context());
    expect(v.errors.find((e) => e.code === 'options_off')?.message).toMatch(
      /Options trading is turned off on this server/,
    );
  });
  it('are refused in O0 even with the switch on', () => {
    const c = codes(withOption(), { ...context(), optionsTradingEnabled: true });
    expect(c).toContain('options_not_built');
    expect(c).not.toContain('options_off');
  });
  it('refuse a bad strike or expiry rule at parse', () => {
    const bad = withOption();
    bad.entry.orders[0]!.option = { ...opt, expiryRule: { targetDte: 0, minDte: 0 } };
    expect(() => parseDefinition(bad)).toThrow();
  });
});
