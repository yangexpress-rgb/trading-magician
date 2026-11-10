import { describe, expect, it } from 'vitest';
import { migrateV4 as migrate } from './migrate-v4';
import { parseDefinition } from './serialize';
import { STOCK_A, validDefinition } from './test-fixtures';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** The migration, with its document typed loosely for the checks. */
const migrateV4 = (d: Json) =>
  migrate(d) as { doc: Json; notes: ReturnType<typeof migrate>['notes'] };

/** A schema 4 document with `rules`, and an Exit that fires on any check it holds. */
function v4(rules: Json[], edit: (d: Json) => void = () => {}): Json {
  const def = JSON.parse(JSON.stringify(validDefinition())) as Json;
  def.schemaVersion = 4;
  def.exit.trigger = { mode: 'while_true', confirmationBars: 0, cooldownBars: 0 };
  def.exit.rules = rules;
  edit(def);
  return def;
}

/** The comparisons the migration added, as "field operator value [period]". */
function added(condition: Json): string[] {
  const out: string[] = [];
  const walk = (n: Json) => {
    if (n.kind === 'group') (n.children as Json[]).forEach(walk);
    else if (n.left?.kind === 'position')
      out.push([n.left.field, n.operator, n.right.value, n.left.period].filter((x) => x).join(' '));
  };
  walk(condition);
  return out;
}

describe('schema 4 → 5: exit rules move into Exit when (N221, ADR 0076)', () => {
  it('turns each rule into its condition on the first Entry leg, and drops it', () => {
    const { doc, notes } = migrateV4(
      v4(
        [
          { kind: 'timeStop', id: 't', barsHeld: 5 },
          { kind: 'atrStop', id: 'a', override: { atrPeriod: 14, atrMultiple: '1.5' } },
          { kind: 'expectedMove', id: 'e', horizon: 1, multiple: '2', side: 'either' },
        ],
        (d) => (d.exit.condition.children = []),
      ),
    );
    expect(doc.schemaVersion).toBe(5);
    expect(doc.exit.rules).toBeUndefined();
    expect(added(doc.exit.condition)).toEqual([
      'days_held gte 5',
      'atrs_below_entry gt 1.5 14',
      'expected_moves_1d gt 2',
      'expected_moves_1d lt -2',
    ]);
    expect(JSON.stringify(doc.exit.condition)).toContain(STOCK_A);
    expect(notes.map((n) => n.code)).toEqual(Array(3).fill('exit_rule_in_exit_when'));
    expect(() => parseDefinition(v4([{ kind: 'timeStop', id: 't', barsHeld: 5 }]))).not.toThrow();
  });

  it("reads the Entry's risk distance for an ATR stop without its own", () => {
    const { doc } = migrateV4(
      v4([{ kind: 'atrStop', id: 'a' }], (d) => {
        d.exit.condition.children = [];
        d.entry.risk = { atrPeriod: 20, atrMultiple: '2' };
      }),
    );
    expect(added(doc.exit.condition)).toEqual(['atrs_below_entry gt 2 20']);
  });

  it('keeps one side for a gain or a loss', () => {
    const one = (side: string) =>
      added(
        migrateV4(
          v4([{ kind: 'expectedMove', id: 'e', horizon: 5, multiple: '1', side }], (d) => {
            d.exit.condition.children = [];
          }),
        ).doc.exit.condition,
      );
    expect(one('gain')).toEqual(['expected_moves_5d gt 1']);
    expect(one('loss')).toEqual(['expected_moves_5d lt -1']);
  });

  it('keeps rules as saved where Fire when could hold the condition back', () => {
    const { doc, notes } = migrateV4(
      v4(
        [
          { kind: 'timeStop', id: 't', barsHeld: 5 },
          { kind: 'leftGroup', id: 'g' },
        ],
        (d) => {
          d.exit.trigger = { mode: 'on_transition', confirmationBars: 0, cooldownBars: 0 };
        },
      ),
    );
    expect(doc.exit.rules).toHaveLength(2);
    expect(notes.map((n) => [n.code, n.effect])).toEqual([['exit_rule_kept', 'grandfathered']]);
  });

  it('leaves Left the group and the kept trailing stop alone', () => {
    const { doc, notes } = migrateV4(
      v4([
        { kind: 'leftGroup', id: 'g' },
        { kind: 'trailingStop', id: 's', percent: '3' },
      ]),
    );
    expect(doc.exit.rules).toHaveLength(2);
    expect(notes).toEqual([]);
  });
});
