import { describe, expect, it } from 'vitest';
import { migrateV3 as migrate, orInto } from './migrate-v3';
import { parseDefinition } from './serialize';
import { comparison, constant, market, STOCK_A, validDefinition } from './test-fixtures';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** A schema 3 document with a 4% trailing stop rule. */
function v3(edit: (d: Json) => void = () => {}): Json {
  const def = JSON.parse(JSON.stringify(validDefinition())) as Json;
  def.schemaVersion = 3;
  def.exit.trigger = { mode: 'while_true', confirmationBars: 0, cooldownBars: 0 };
  def.exit.rules = [{ kind: 'trailingStop', id: 'ts', percent: '4' }];
  edit(def);
  return def;
}

/** The migration, with its document typed loosely for the checks. */
const migrateV3 = (d: Json) =>
  migrate(d) as { doc: Json; notes: ReturnType<typeof migrate>['notes'] };

const trailingOf = (c: Json) =>
  (c.children as Json[]).find((x) => x.id === 'trailing-ts') as Json | undefined;

describe('schema 3 → 4: the trailing stop moves into Exit when (N217, ADR 0074)', () => {
  it('ORs "Off best close since entry % > N" into Exit when and drops the rule', () => {
    const { doc, notes } = migrateV3(v3());
    expect(doc.schemaVersion).toBe(4);
    expect(doc.exit.rules).toBeUndefined();
    const c = doc.exit.condition.op === 'or' ? doc.exit.condition : undefined;
    const t = trailingOf(c ?? { children: [] });
    expect(t).toMatchObject({
      operator: 'gt',
      left: { kind: 'position', field: 'off_peak_pct', instrumentId: STOCK_A },
      right: { kind: 'constant', value: '4' },
    });
    expect(notes.map((n) => [n.code, n.effect])).toEqual([['trailing_stop_in_exit_when', 'same']]);
    expect(() => parseDefinition(v3())).not.toThrow();
  });

  it('keeps the other exit rules', () => {
    const { doc } = migrateV3(
      v3((d) => d.exit.rules.push({ kind: 'timeStop', id: 't', barsHeld: 5 })),
    );
    expect(doc.exit.rules).toEqual([{ kind: 'timeStop', id: 't', barsHeld: 5 }]);
  });

  it('keeps the rule as saved when Fire when could wait where the rule would not', () => {
    for (const trigger of [
      { mode: 'on_transition', confirmationBars: 0, cooldownBars: 0 },
      { mode: 'while_true', confirmationBars: 2, cooldownBars: 0 },
      { mode: 'while_true', confirmationBars: 0, cooldownBars: 3 },
    ]) {
      const { doc, notes } = migrateV3(v3((d) => (d.exit.trigger = trigger)));
      expect(doc.exit.rules).toEqual([{ kind: 'trailingStop', id: 'ts', percent: '4' }]);
      expect(notes.map((n) => [n.code, n.effect])).toEqual([
        ['trailing_stop_kept', 'grandfathered'],
      ]);
    }
  });

  it('converts a group whatever its Fire when, since a group has none', () => {
    const { doc } = migrateV3(
      v3((d) => {
        d.trade = { kind: 'group', universe: { type: 'builtin', id: 'sp500' } };
        d.exit.trigger = { mode: 'on_transition', confirmationBars: 0, cooldownBars: 0 };
      }),
    );
    expect(doc.exit.rules).toBeUndefined();
  });

  it('keeps it where per-leg conditions watch each leg separately', () => {
    const { doc, notes } = migrateV3(
      v3(
        (d) =>
          (d.entry.orders[0].legCondition = {
            kind: 'group',
            id: 'lc',
            op: 'and',
            negate: false,
            children: [],
          }),
      ),
    );
    expect(doc.exit.rules).toHaveLength(1);
    expect(notes[0]?.code).toBe('trailing_stop_kept');
  });

  it('converts each entry group on its own', () => {
    const { notes } = migrateV3(
      v3((d) => {
        d.groups = [JSON.parse(JSON.stringify({ ...d, id: 'g1', label: 'Second' }))];
        d.groups[0].exit.trigger = { mode: 'on_transition', confirmationBars: 0, cooldownBars: 0 };
      }),
    );
    expect(notes.map((n) => [n.code, n.where])).toEqual([
      ['trailing_stop_in_exit_when', 'exit.condition'],
      ['trailing_stop_kept', 'groups[0].exit.rules'],
    ]);
  });
});

describe('orInto', () => {
  const c = { kind: 'comparison', id: 'new' };
  const a = comparison('a', market('m'), 'gt', constant('1'));

  it('fills an empty condition', () => {
    expect(orInto({ kind: 'group', id: 'r', op: 'and', negate: false, children: [] }, c)).toEqual({
      kind: 'group',
      id: 'r',
      op: 'or',
      negate: false,
      children: [c],
    });
  });

  it('appends to an OR', () => {
    const root = { kind: 'group', id: 'r', op: 'or', negate: false, children: [a] };
    expect(orInto(root, c).children).toEqual([a, c]);
  });

  it('wraps an AND, keeping it as it reads', () => {
    const root = { kind: 'group', id: 'r', op: 'and', negate: false, children: [a] };
    expect(orInto(root, c)).toEqual({
      kind: 'group',
      id: 'r-or-trailing',
      op: 'or',
      negate: false,
      children: [root, c],
    });
  });
});
