import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import type { PlannedOrder, StrategyDefinition } from '../strategy/schema';
import { CAPS, context, order, PAPER_ACCOUNT, validDefinition } from '../strategy/test-fixtures';
import type { AccountInfo } from '../strategy/validate';
import { validateStrategy } from '../strategy/validate';
import { hasCombo } from './combo';
import { coveredStructures, sharesCoverShortCall, soldOptionRisk } from './covered';
import { optionRollDue } from './exits';

/** Covered calls, cash-secured puts and the roll rule (ADR 0123, Phase O3). */

const spec = (right: 'call' | 'put'): NonNullable<PlannedOrder['option']> => ({
  right,
  strikeRule: { type: 'moneynessPct', pct: 5 },
  expiryRule: { targetDte: 30, minDte: 7 },
});

/** Buy 100 DEMO-A and sell 1 call on them; exit mirrors it. */
function coveredCall(shares = '100', contracts = '1'): StrategyDefinition {
  const def = validDefinition();
  def.entry.orders = [
    order('shares', { quantity: { type: 'units', value: shares, rounding: 'down' } }),
    order('call', {
      side: 'sell_short',
      quantity: { type: 'units', value: contracts, rounding: 'down' },
      option: spec('call'),
    }),
  ];
  def.exit.orders = [
    order('sell-shares', {
      side: 'sell',
      quantity: { type: 'units', value: shares, rounding: 'down' },
    }),
    order('buy-call', {
      side: 'buy_to_cover',
      quantity: { type: 'units', value: contracts, rounding: 'down' },
      option: spec('call'),
    }),
  ];
  return def;
}

function cashSecuredPut(): StrategyDefinition {
  const def = validDefinition();
  def.entry.orders = [
    order('put', {
      side: 'sell_short',
      quantity: { type: 'units', value: '2', rounding: 'down' },
      option: spec('put'),
    }),
  ];
  def.exit.orders = [
    order('buy-put', {
      side: 'buy_to_cover',
      quantity: { type: 'units', value: '2', rounding: 'down' },
      option: spec('put'),
    }),
  ];
  return def;
}

const atLevel = (level: 0 | 1 | 2 | 3) => {
  const ctx = { ...context(), optionsTradingEnabled: true };
  (ctx.accounts as Map<string, AccountInfo>).set(PAPER_ACCOUNT, {
    ...ctx.accounts.get(PAPER_ACCOUNT)!,
    capabilities: { ...CAPS, optionsLevel: level },
  });
  return ctx;
};
const codes = (def: StrategyDefinition, level: 0 | 1 | 2 | 3 = 1) =>
  validateStrategy(def, atLevel(level)).errors.map((e) => e.code);

describe('covered calls and cash-secured puts at save time (O3)', () => {
  it('accept a call sold on 100 shares bought in the same Entry, at level 1', () => {
    expect(codes(coveredCall())).toEqual([]);
    expect(coveredStructures(coveredCall().entry.orders).map((s) => s.kind)).toEqual([
      'covered_call',
    ]);
    // Not a combo: it needs level 1, not 3.
    expect(hasCombo(coveredCall())).toBe(false);
    expect(codes(coveredCall(), 0)).toContain('options_level');
  });
  it('refuse a call sold on too few shares, naming how many it needs', () => {
    const v = validateStrategy(coveredCall('150', '2'), atLevel(1));
    const e = v.errors.find((x) => x.code === 'options_uncovered_call');
    expect(e?.message).toMatch(/sells 2 calls, which need 200 shares to cover/);
  });
  it('still refuse a call sold with no shares as naked, as in O2', () => {
    const def = coveredCall();
    def.entry.orders = def.entry.orders.filter((o) => o.id !== 'shares');
    def.exit.orders = def.exit.orders.filter((o) => o.id !== 'sell-shares');
    const v = validateStrategy(def, atLevel(3));
    expect(v.errors.map((x) => x.code)).toContain('options_naked_call');
    expect(v.errors.find((x) => x.code === 'options_naked_call')?.message).toMatch(
      /buy 100 shares for each call sold in this Entry/,
    );
  });
  it('accept a put sold alone as cash-secured, at level 1', () => {
    expect(codes(cashSecuredPut())).toEqual([]);
    expect(coveredStructures(cashSecuredPut().entry.orders).map((s) => s.kind)).toEqual([
      'cash_secured_put',
    ]);
  });
  it('size covered structures in whole contracts', () => {
    const def = cashSecuredPut();
    def.entry.orders[0]!.quantity = { type: 'notional', value: '500', rounding: 'down' };
    expect(codes(def)).toContain('options_covered_size');
  });
  it('leave a combo needing level 3, as in O2', () => {
    const def = cashSecuredPut();
    def.entry.orders.push(
      order('long-put', {
        quantity: { type: 'units', value: '2', rounding: 'down' },
        option: { ...spec('put'), strikeRule: { type: 'moneynessPct', pct: 10 } },
      }),
    );
    expect(hasCombo(def)).toBe(true);
    expect(codes(def, 1)).toContain('options_level');
  });
});

describe('sold-option risk at pricing time (O3)', () => {
  it('counts a cash-secured put at strike less premium, and sets aside the strike', () => {
    // 2 puts at strike 95 for 1.20: max loss (95 − 1.20) × 100 × 2, cash 95 × 100 × 2.
    const r = soldOptionRisk({ right: 'put', strike: '95', contracts: 2, limit: '1.20' });
    expect(r.ok && r.atRisk.toString()).toBe('18760');
    expect(r.ok && r.buyingPower.toString()).toBe('19000');
  });
  it('adds nothing for a covered call, but needs its shares held', () => {
    const ok = soldOptionRisk({
      right: 'call',
      strike: '105',
      contracts: 1,
      limit: '2',
      sharesHeld: 100,
    });
    expect(ok.ok && ok.atRisk.toString()).toBe('0');
    const short = soldOptionRisk({
      right: 'call',
      strike: '105',
      contracts: 2,
      limit: '2',
      sharesHeld: 150,
    });
    expect(short).toMatchObject({ ok: false, code: 'options_uncovered_call' });
  });
  it('tells which shares cover a short call', () => {
    const positions = new Map([
      ['call', new Decimal(-1)],
      ['A', new Decimal(100)],
    ]);
    const optionOf = (id: string) =>
      id === 'call' ? { underlyingId: 'A', right: 'call' as const } : undefined;
    expect(sharesCoverShortCall(positions, optionOf, 'A')).toBe(true);
    expect(sharesCoverShortCall(positions, optionOf, 'B')).toBe(false);
    expect(sharesCoverShortCall(new Map([['A', new Decimal(100)]]), optionOf, 'A')).toBe(false);
  });
});

describe('the roll rule (O3)', () => {
  it('is due once a contract has its days to expiry or fewer', () => {
    const rules = [{ kind: 'optionRoll' as const, id: 'roll', days: 5 }];
    expect(optionRollDue(rules, [{ expiry: '2026-10-20' }], '2026-10-14')).toBe(false);
    expect(optionRollDue(rules, [{ expiry: '2026-10-20' }], '2026-10-15')).toBe(true);
    expect(optionRollDue([], [{ expiry: '2026-10-20' }], '2026-10-19')).toBe(false);
  });
  it('validates when the roll comes before the Entry minimum days, and refuses otherwise', () => {
    const def = coveredCall();
    def.exit.rules = [{ kind: 'optionRoll', id: 'roll', days: 5 }];
    expect(codes(def)).toEqual([]);
    def.exit.rules = [{ kind: 'optionRoll', id: 'roll', days: 7 }];
    expect(codes(def)).toContain('options_roll_days');
  });
  it('is an options rule: refused on a strategy without options', () => {
    const def = validDefinition();
    def.exit.rules = [{ kind: 'optionRoll', id: 'roll', days: 5 }];
    expect(codes(def)).toContain('option_rule_without_options');
  });
});
