import { describe, expect, it } from 'vitest';
import { randomId } from './ids';
import type { ConditionGroup, StrategyDefinition } from './schema';
import { comparison, constant, context, market, order, validDefinition } from './test-fixtures';
import { cloneOrder, duplicateNode } from './tree';
import { validateStrategy } from './validate';

/**
 * N154: the builder's Duplicate buttons give the copy, and everything nested
 * inside it, fresh ids, so a strategy with duplicated conditions, groups,
 * legs and orders still saves.
 */

/** Every `id` anywhere in the definition, with repeats. */
function allIds(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const v of value) allIds(v, out);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'id' && typeof v === 'string') out.push(v);
      else allIds(v, out);
    }
  }
  return out;
}

const nested = (): ConditionGroup => ({
  kind: 'group',
  id: 'leg-root',
  op: 'and',
  negate: false,
  children: [
    comparison('leg-c1', market('leg-m1'), 'gt', constant('1')),
    {
      kind: 'group',
      id: 'leg-inner',
      op: 'or',
      negate: false,
      children: [
        comparison('leg-c2', market('leg-m2'), 'lt', constant('2')),
        comparison('leg-c3', market('leg-m3'), 'gt', constant('3')),
      ],
    },
  ],
});

function strategyWithNesting(): StrategyDefinition {
  const def = validDefinition();
  def.entry.condition.children.push({
    kind: 'group',
    id: 'entry-group',
    op: 'and',
    negate: false,
    children: [
      comparison('eg-c1', market('eg-m1'), 'gt', constant('10')),
      comparison('eg-c2', market('eg-m2'), 'lt', constant('20')),
    ],
  });
  def.entry.orders = [
    order('buy-a', {
      orderType: 'limit',
      limitPrice: constant('100', 'lp-1'),
      legCondition: nested(),
    }),
  ];
  return def;
}

describe('duplicating builder entities', () => {
  it('a duplicated group with nested conditions and a duplicated leg with a nested leg condition keep every id unique', () => {
    const def = strategyWithNesting();
    // Duplicate a condition, a group (with its nested conditions), a leg and an order.
    def.entry.condition = duplicateNode(def.entry.condition, 'entry-cross');
    def.entry.condition = duplicateNode(def.entry.condition, 'entry-group');
    const leg = def.entry.orders[0]!;
    def.entry.orders = [...def.entry.orders, { ...cloneOrder(leg), legLabel: 'buy-a copy' }];
    const exitOrder = def.exit.orders[0]!;
    def.exit.orders = [...def.exit.orders, { ...cloneOrder(exitOrder), legLabel: 'sell-a copy' }];
    // A group nested inside the copied leg's condition, duplicated there too.
    const copy = def.entry.orders[1]!;
    const innerCopyId = copy.legCondition!.children[1]!.id;
    def.entry.orders[1] = {
      ...copy,
      legCondition: duplicateNode(copy.legCondition!, innerCopyId),
    };

    const ids = allIds(def);
    expect(new Set(ids).size).toBe(ids.length);
    const { errors } = validateStrategy(def, context());
    expect(errors.filter((e) => e.code === 'duplicate_id')).toEqual([]);
    expect(errors).toEqual([]);
    // The copies are real copies: same shape, other ids.
    expect(def.entry.orders[1]!.legCondition!.children).toHaveLength(3);
    expect(def.entry.orders[1]!.limitPrice).toMatchObject({ kind: 'constant', value: '100' });
    expect(def.entry.orders[1]!.limitPrice!.id).not.toBe('lp-1');
  });

  it('the copy of a leg shares no id with the original, at any depth', () => {
    const leg = order('buy-a', { legCondition: nested(), stopPrice: constant('90', 'sp') });
    const copy = cloneOrder(leg, randomId);
    const before = new Set(allIds(leg));
    expect(allIds(copy).filter((id) => before.has(id))).toEqual([]);
    expect(allIds(copy)).toHaveLength(allIds(leg).length);
    // The original is untouched.
    expect(leg.legCondition!.id).toBe('leg-root');
  });
});
