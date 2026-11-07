import { describe, expect, it } from 'vitest';
import { allOrders } from './tree';
import { directionOf, entryGroups, groupDefinition, isTwoSided } from './groups';
import { parseDefinition } from './serialize';
import type { StrategyDefinition } from './schema';
import {
  CAPS,
  comparison,
  constant,
  context,
  market,
  order,
  PAPER_ACCOUNT,
  STOCK_A,
  validDefinition,
} from './test-fixtures';
import { validateStrategy } from './validate';

/** Design v1.2 item 8: long and short entry groups in one strategy. */
function twoSided(): StrategyDefinition {
  const def = validDefinition();
  def.entry.direction = 'long';
  def.groups = [
    {
      id: 'short-1',
      label: 'Short breakdown',
      entry: {
        direction: 'short',
        condition: {
          kind: 'group',
          id: 'sg',
          op: 'and',
          negate: false,
          children: [comparison('s-entry', market('sm1'), 'lt', constant('90'))],
        },
        trigger: { mode: 'on_transition', cooldownBars: 0, confirmationBars: 0 },
        orders: [order('short-a', { side: 'sell_short', legLabel: 'Short A' })],
      },
      exit: {
        condition: {
          kind: 'group',
          id: 'sx',
          op: 'and',
          negate: false,
          children: [comparison('s-exit', market('sm2'), 'gt', constant('100'))],
        },
        trigger: { mode: 'on_transition', cooldownBars: 0, confirmationBars: 0 },
        orders: [order('cover-a', { side: 'buy_to_cover', legLabel: 'Cover A' })],
      },
    },
  ];
  return def;
}

const codes = (def: StrategyDefinition, ctx = context()) => {
  const v = validateStrategy(def, ctx);
  return [...v.errors, ...v.warnings].map((e) => e.code);
};

describe('entry groups (v1.2 item 8)', () => {
  it('parse, list each group with its direction, and run each as a strategy of its own', () => {
    const def = parseDefinition(twoSided());
    expect(entryGroups(def).map((g) => [g.key, g.label, g.direction])).toEqual([
      [null, 'Group 1', 'long'],
      ['short-1', 'Short breakdown', 'short'],
    ]);
    const g = groupDefinition(def, 'short-1');
    expect(g.entry.orders[0]?.side).toBe('sell_short');
    expect(g.groups).toBeUndefined();
    expect(allOrders(def).map((o) => o.id)).toEqual(['buy-a', 'short-a', 'sell-a', 'cover-a']);
    expect(isTwoSided(def)).toBe(true);
    expect(isTwoSided(validDefinition())).toBe(false);
  });

  it('reads an older strategy that sells short as short', () => {
    const def = validDefinition();
    def.entry.orders = [order('s', { side: 'sell_short' })];
    expect(directionOf(def.entry)).toBe('short');
    expect(directionOf(validDefinition().entry)).toBe('long');
  });

  it('validates a long and a short group together', () => {
    expect(validateStrategy(twoSided(), context()).errors).toEqual([]);
  });

  it('says when a leg does not match its group direction', () => {
    const def = twoSided();
    def.groups![0]!.entry.orders[0]!.side = 'buy';
    const v = validateStrategy(def, context());
    const e = v.errors.find((x) => x.code === 'direction_side_mismatch');
    expect(e?.message).toBe(
      '"Short breakdown" goes short: its Entry leg "Short A" must Sell short',
    );
    expect(e?.path).toEqual(['groups', 0, 'entry', 'orders', 0, 'side']);
  });

  it('needs one cycle at a time, and fixed legs', () => {
    const def = twoSided();
    def.execution.reentry = { mode: 'independent_cycles' };
    expect(codes(def)).toContain('groups_single_position');
    const legs = twoSided();
    legs.entry.orders[0]!.legCondition = {
      kind: 'group',
      id: 'lc',
      op: 'and',
      negate: false,
      children: [comparison('lc1', market('lm'), 'gt', constant('1'))],
    };
    expect(codes(legs)).toContain('groups_fixed_legs_only');
  });

  it('refuses a short group on an account that cannot short', () => {
    const ctx = context();
    ctx.accounts = new Map([
      [
        PAPER_ACCOUNT,
        {
          nickname: 'Cash',
          mode: 'paper',
          isActive: true,
          capabilities: { ...CAPS, shortSelling: false },
        },
      ],
    ]);
    const v = validateStrategy(twoSided(), ctx);
    const e = v.errors.find((x) => x.code === 'short_selling_unsupported');
    expect(e?.message).toBe(`"Cash" doesn't allow short selling`);
    expect(e?.path.slice(0, 2)).toEqual(['groups', 0]);
  });

  it('refuses an instrument the broker does not lend, and allows an unknown one', () => {
    const ctx = context();
    ctx.instruments = new Map([
      [STOCK_A, { symbol: 'DEMO-A', assetClass: 'stock', lotSize: '1', shortable: false }],
    ]);
    expect(codes(twoSided(), ctx)).toContain('not_shortable');
    expect(codes(twoSided())).not.toContain('not_shortable');
  });

  it('checks group conditions and leg labels like the strategy’s own', () => {
    const def = twoSided();
    def.groups![0]!.entry.orders[0]!.legLabel = 'buy-a';
    def.groups![0]!.exit.condition.children = [];
    const c = codes(def);
    expect(c).toContain('duplicate_leg_label');
    expect(c).toContain('empty_condition');
  });
});
