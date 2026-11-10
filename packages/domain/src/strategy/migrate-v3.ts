import type { MigrationNote } from './migrate-v1';

/**
 * Schema version 3 → 4: the trailing stop moves into Exit when (N217,
 * ADR 0074). Stored versions are never rewritten; every read goes through
 * this, as with the earlier steps.
 *
 * A "Trailing stop N%" exit rule becomes the Exit when condition "Off best
 * close since entry % > N" on the first Entry leg's instrument, added by OR,
 * so it exits on exactly the closes the rule did. That holds when Exit when
 * exits on any check it is true: a group's Exit (no Fire when), or Fire when
 * "while true" with no confirmation or cooldown. Under any other Fire when
 * the rule could fire where the condition would wait, so the rule is kept as
 * saved and still runs; the builder no longer offers it.
 *
 * Works on plain JSON, before the schema parses it.
 */

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Whether Exit when exits on any check it holds, so an OR'd condition fires as the rule did. */
function firesOnAnyTrue(exit: Json): boolean {
  const t = exit.trigger;
  if (!isObj(t)) return true;
  return (
    t.mode === 'while_true' &&
    Number(t.confirmationBars ?? 0) === 0 &&
    Number(t.cooldownBars ?? 0) === 0
  );
}

/**
 * Whether an exit rule of `part` can become an Exit when condition with the
 * same exits: a group's Exit (no Fire when; its slots drop it, ADR 0049), or
 * a Fire when that exits on any check the condition holds. Per-leg conditions
 * and ranked legs (O148) watch each slot's own leg, which one condition on the
 * first leg's instrument would not, so those keep their rules.
 */
export function movesIntoExitWhen(doc: Json, part: Json, at: string): boolean {
  const entry = isObj(part.entry) ? part.entry : {};
  const exit = isObj(part.exit) ? part.exit : {};
  const isGroup = at === '' && isObj(doc.trade) && doc.trade.kind === 'group';
  const legSlots =
    at === '' &&
    (isObj(entry.rankedLegs) || arr(entry.orders).some((o) => isObj(o) && isObj(o.legCondition)));
  return !legSlots && (isGroup || firesOnAnyTrue(exit));
}

/** "Off best close since entry % > percent": the trailing stop as an Exit when condition. */
export function offPeakCondition(id: string, instrumentId: unknown, percent: unknown): Json {
  return {
    kind: 'comparison',
    id,
    left: {
      kind: 'position',
      id: `${id}-off`,
      field: 'off_peak_pct',
      instrumentId,
      interval: '1d',
      adjustment: 'split_and_dividend',
      session: 'regular',
    },
    operator: 'gt',
    right: { kind: 'constant', id: `${id}-pct`, value: String(percent) },
  };
}

/** Adds `c` to Exit when by OR, keeping the existing condition as it reads. */
export function orInto(condition: unknown, c: Json): Json {
  const root = isObj(condition) ? condition : { kind: 'group', id: 'exit-root', op: 'or' };
  const children = arr(root.children);
  if (children.length === 0) return { ...root, op: 'or', negate: false, children: [c] };
  if (root.op === 'or' && root.negate !== true) return { ...root, children: [...children, c] };
  return {
    kind: 'group',
    id: `${String(root.id)}-or-trailing`,
    op: 'or',
    negate: false,
    children: [root, c],
  };
}

export function migrateV3(input: Json): { doc: Json; notes: MigrationNote[] } {
  const doc = structuredClone(input);
  const notes: MigrationNote[] = [];
  const parts: { part: Json; at: string }[] = [{ part: doc, at: '' }];
  arr(doc.groups).forEach((g, i) => {
    if (isObj(g)) parts.push({ part: g, at: `groups[${i}].` });
  });
  for (const { part, at } of parts) {
    const entry = isObj(part.entry) ? part.entry : {};
    const exit = isObj(part.exit) ? part.exit : undefined;
    if (!exit) continue;
    const rules = arr(exit.rules);
    const trailing = rules.find((r) => isObj(r) && r.kind === 'trailingStop');
    if (!isObj(trailing)) continue;
    if (!movesIntoExitWhen(doc, part, at)) {
      notes.push({
        code: 'trailing_stop_kept',
        effect: 'grandfathered',
        message:
          'The trailing stop rule is kept as saved and runs as before: moving it into Exit when would change when it exits',
        where: `${at}exit.rules`,
      });
      continue;
    }
    const first = arr(entry.orders)[0];
    const instrumentId = isObj(first) ? first.instrumentId : undefined;
    const id = `trailing-${String(trailing.id ?? 'stop')}`;
    exit.condition = orInto(exit.condition, offPeakCondition(id, instrumentId, trailing.percent));
    const rest = rules.filter((r) => r !== trailing);
    if (rest.length > 0) exit.rules = rest;
    else delete exit.rules;
    notes.push({
      code: 'trailing_stop_in_exit_when',
      effect: 'same',
      message: `The ${String(trailing.percent)}% trailing stop is now the Exit when condition "Off best close since entry % > ${String(trailing.percent)}"; its exits are labelled Exit condition`,
      where: `${at}exit.condition`,
    });
  }
  doc.schemaVersion = 4;
  return { doc, notes };
}
