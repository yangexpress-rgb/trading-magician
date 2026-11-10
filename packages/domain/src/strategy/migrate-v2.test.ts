import { describe, expect, it } from 'vitest';
import type { MigrationNote } from './migrate-v1';
import { migrateV2 } from './migrate-v2';
import { parseDefinition } from './serialize';
import {
  STOCK_A,
  STOCK_B,
  comparison,
  constant,
  context,
  market,
  validDefinition,
} from './test-fixtures';
import { validateStrategy } from './validate';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** A schema 2 document: the current one put back into the shape it had before ADR 0073. */
function v2(edit: (d: Json) => void = () => {}): Json {
  const def = JSON.parse(JSON.stringify(validDefinition())) as Json;
  def.schemaVersion = 2;
  delete def.trade;
  def.entry.kind = 'conditions';
  edit(def);
  return def;
}

/** Like Yong's "Earnings breakout (test)": S&P 500, top 10, $20,000 total, keep each pick. */
function earningsBreakoutV2(keepHoldings = true): Json {
  return v2((d) => {
    d.entry.kind = 'selection';
    d.entry.selection = {
      universe: { type: 'builtin', id: 'sp500' },
      ranking: { metric: 'return', params: { lookbackMonths: 1 } },
      direction: 'desc',
      count: { type: 'fixed', value: 10 },
      keepHoldings,
      preFilter: {
        kind: 'group',
        id: 'pre',
        op: 'and',
        children: [comparison('up-day', market('pm'), 'gt', constant('0'))],
      },
    };
    d.entry.orders[0].quantity = { type: 'notional', value: '20000' };
    d.schedule = { frequency: 'daily', time: '15:50' };
  });
}

/** The migrated document, typed loosely for reading back. */
const mig = (d: Json) => migrateV2(d) as { doc: Json; notes: MigrationNote[] };
const codes = (doc: Json) => mig(doc).notes.map((n) => n.code);

describe('migrateV2 (schema 2 → 3)', () => {
  it('reads a specific-asset strategy as What to trade = its assets, unchanged otherwise', () => {
    const { doc, notes } = mig(v2());
    expect(doc.schemaVersion).toBe(3);
    expect(doc.trade).toEqual({ kind: 'assets' });
    expect(doc.entry).not.toHaveProperty('kind');
    expect(notes.every((n) => n.effect === 'same')).toBe(true);
    const parsed = parseDefinition(v2());
    expect(parsed).toEqual(validDefinition());
    expect(validateStrategy(parsed, context()).errors).toEqual([]);
  });

  it('moves the schedule into Entry and leaves Exit on every bar', () => {
    const doc = v2((d) => (d.schedule = { frequency: 'weekly' }));
    const parsed = parseDefinition(doc);
    expect(parsed.entry.schedule).toEqual({ frequency: 'weekly' });
    expect(parsed.exit.schedule).toBeUndefined();
    expect(parsed).not.toHaveProperty('schedule');
    expect(codes(doc)).toContain('schedule_moved');
  });

  it('turns a Selection group into a group with filter and ranking, $20,000 / 10 = $2,000 per pick', () => {
    const { doc, notes } = mig(earningsBreakoutV2());
    expect(doc.trade).toMatchObject({
      kind: 'group',
      universe: { type: 'builtin', id: 'sp500' },
      filter: { id: 'pre' },
      ranking: { metric: 'return', direction: 'desc', count: { type: 'fixed', value: 10 } },
    });
    expect(doc.trade).not.toHaveProperty('splitTotal');
    expect(doc.entry.orders[0].quantity.value).toBe('2000');
    expect(doc.entry.schedule).toEqual({ frequency: 'daily', time: '15:50' });
    // Kept each pick until its own exit: no "Left the group" rule.
    expect(doc.exit.rules ?? []).not.toContainEqual(expect.objectContaining({ kind: 'leftGroup' }));
    expect(notes.map((n) => n.code)).toEqual(['trade_group', 'per_pick_amount', 'schedule_moved']);
    expect(() => parseDefinition(earningsBreakoutV2())).not.toThrow();
  });

  it('adds the "Left the group" exit rule where holdings used to be rebalanced out', () => {
    const { doc } = mig(earningsBreakoutV2(false));
    expect(doc.exit.rules).toContainEqual({ kind: 'leftGroup', id: 'left-group' });
    expect(codes(earningsBreakoutV2(false))).toContain('left_group_rule');
  });

  it('keeps a percentage count as a total split equally', () => {
    const doc = earningsBreakoutV2();
    doc.entry.selection.count = { type: 'percent', value: 10 };
    const migrated = mig(doc).doc;
    expect(migrated.trade.splitTotal).toBe(true);
    expect(migrated.entry.orders[0].quantity.value).toBe('20000');
  });

  it('keeps ranked legs and per-leg conditions as saved', () => {
    const doc = v2((d) => {
      d.entry.kind = 'selection';
      d.entry.selection = {
        universe: { type: 'legs' },
        ranking: { metric: 'return', params: {} },
        direction: 'desc',
        count: { type: 'fixed', value: 1 },
      };
      d.entry.orders.push({
        ...d.entry.orders[0],
        id: 'buy-b',
        legLabel: 'buy-b',
        instrumentId: STOCK_B,
      });
    });
    const parsed = parseDefinition(doc);
    expect(parsed.trade).toEqual({ kind: 'assets' });
    expect(parsed.entry.rankedLegs).toMatchObject({ metric: 'return', count: { value: 1 } });
    expect(parsed.entry.orders.map((o) => o.instrumentId)).toEqual([STOCK_A, STOCK_B]);
    expect(mig(doc).notes.find((n) => n.code === 'ranked_legs_kept')?.effect).toBe('grandfathered');
  });

  it('leaves the stored document untouched', () => {
    const doc = earningsBreakoutV2();
    const before = JSON.stringify(doc);
    mig(doc);
    expect(JSON.stringify(doc)).toBe(before);
  });
});
