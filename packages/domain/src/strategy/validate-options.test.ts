import { describe, expect, it } from 'vitest';
import { parseDefinition } from './serialize';
import type { PlannedOrder, StrategyDefinition } from './schema';
import { CAPS, context, PAPER_ACCOUNT, validDefinition } from './test-fixtures';
import type { AccountInfo } from './validate';
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

const on = () => ({ ...context(), optionsTradingEnabled: true });

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
  it('accept a long call bought and sold to close with the switch on (O1)', () => {
    const def = withOption();
    def.exit.orders[0] = { ...def.exit.orders[0]!, option: opt };
    def.exit.rules = [
      { kind: 'optionTarget', id: 'tgt', pct: '50' },
      { kind: 'optionDte', id: 'dte', days: 5 },
    ];
    expect(codes(def, on())).toEqual([]);
  });
  it('warn that a tight strategy trailing stop reads the premium', () => {
    const def = withOption();
    def.exit.orders[0] = { ...def.exit.orders[0]!, option: opt };
    def.risk.trailingStopPct = '1';
    const w = validateStrategy(def, on()).warnings.map((x) => x.code);
    expect(w).toContain('options_trailing_stop');
    def.risk.trailingStopPct = '30';
    expect(validateStrategy(def, on()).warnings.map((x) => x.code)).not.toContain(
      'options_trailing_stop',
    );
  });
  it('refuse what O1 does not trade, each with its reason', () => {
    const c = (edit: (d: StrategyDefinition) => void, ctx = on()) => {
      const def = withOption();
      def.exit.orders[0] = { ...def.exit.orders[0]!, option: opt };
      edit(def);
      return codes(def, ctx);
    };
    expect(c((d) => (d.entry.orders[0]!.side = 'sell_short'))).toContain('options_sell_to_open');
    expect(c((d) => (d.entry.orders[0]!.orderType = 'limit'))).toContain('options_order_type');
    expect(c((d) => (d.entry.orders[0]!.timeInForce = 'ioc'))).toContain('options_time_in_force');
    expect(c((d) => (d.entry.orders[0]!.quantity.type = 'pct_equity'))).toContain(
      'options_quantity',
    );
    expect(c((d) => (d.execution.marketHoursPolicy = 'extended_if_supported'))).toContain(
      'options_extended_hours',
    );
    expect(
      c((d) => {
        d.exit.mirrorEntry = false;
        d.exit.orders[0]!.option = { ...opt, right: 'put' };
      }),
    ).toContain('options_exit_unmatched');
    const live = on();
    (live.accounts as Map<string, AccountInfo>).set(PAPER_ACCOUNT, {
      ...live.accounts.get(PAPER_ACCOUNT)!,
      mode: 'live',
    });
    expect(c(() => {}, live)).toContain('options_live_account');
    const low = on();
    (low.accounts as Map<string, AccountInfo>).set(PAPER_ACCOUNT, {
      ...low.accounts.get(PAPER_ACCOUNT)!,
      capabilities: { ...CAPS, optionsLevel: 1 },
    });
    expect(c(() => {}, low)).toContain('options_level');
  });
  it('refuse an options exit on a strategy without options', () => {
    const def = validDefinition();
    def.exit.rules = [{ kind: 'optionDte', id: 'dte', days: 5 }];
    expect(codes(def, on())).toContain('option_rule_without_options');
  });
  it('refuse a bad strike or expiry rule at parse', () => {
    const bad = withOption();
    bad.entry.orders[0]!.option = { ...opt, expiryRule: { targetDte: 0, minDte: 0 } };
    expect(() => parseDefinition(bad)).toThrow();
  });
});
