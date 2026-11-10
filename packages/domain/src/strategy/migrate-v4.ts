import type { MigrationNote } from './migrate-v1';
import { movesIntoExitWhen, orInto } from './migrate-v3';

/**
 * Schema version 4 → 5: the holding-period exit, the ATR stop and the
 * expected-move exit move into Exit when (N221, ADR 0076), as the trailing
 * stop did in schema 4. Stored versions are never rewritten; every read goes
 * through this, as with the earlier steps.
 *
 * - "Hold N days" becomes "Trading days held ≥ N".
 * - The ATR stop becomes "Below entry, in ATRs at entry > multiple", with the
 *   ATR period of its distance (its own, else the Entry's risk distance).
 * - The expected-move exit becomes "Move since entry, in expected moves >
 *   multiple" for a gain, "< −multiple" for a loss, and both for either.
 *
 * Each is added to Exit when by OR on the first Entry leg's instrument, so it
 * exits on exactly the closes the rule did, where `movesIntoExitWhen` says
 * that holds; elsewhere the rule is kept as saved and still runs.
 *
 * Works on plain JSON, before the schema parses it.
 */

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** A position value as a comparison with a constant: "<field> <operator> <value>". */
export function holdingCondition(
  id: string,
  instrumentId: unknown,
  field: string,
  operator: 'gt' | 'gte' | 'lt',
  value: string,
  period?: number,
): Json {
  return {
    kind: 'comparison',
    id,
    left: {
      kind: 'position',
      id: `${id}-value`,
      field,
      ...(period === undefined ? {} : { period }),
      instrumentId,
      interval: '1d',
      adjustment: 'split_and_dividend',
      session: 'regular',
    },
    operator,
    right: { kind: 'constant', id: `${id}-limit`, value },
  };
}

const negate = (v: string) => (v.startsWith('-') ? v.slice(1) : `-${v}`);

const LABELS: Record<string, string> = {
  timeStop: 'holding-period exit',
  atrStop: 'ATR stop',
  expectedMove: 'expected-move exit',
};

/** The Exit when conditions a rule becomes, or undefined when it has nothing to check. */
function conditionsFor(rule: Json, part: Json, instrumentId: unknown): Json[] | undefined {
  const id = `${String(rule.kind)}-${String(rule.id ?? 'rule')}`;
  if (rule.kind === 'timeStop')
    return [holdingCondition(id, instrumentId, 'days_held', 'gte', String(rule.barsHeld))];
  if (rule.kind === 'atrStop') {
    const entry = isObj(part.entry) ? part.entry : {};
    const d = isObj(rule.override) ? rule.override : isObj(entry.risk) ? entry.risk : undefined;
    if (!d) return undefined;
    return [
      holdingCondition(
        id,
        instrumentId,
        'atrs_below_entry',
        'gt',
        String(d.atrMultiple),
        Number(d.atrPeriod),
      ),
    ];
  }
  if (rule.kind === 'expectedMove') {
    const field = Number(rule.horizon) === 1 ? 'expected_moves_1d' : 'expected_moves_5d';
    const m = String(rule.multiple);
    const gain = holdingCondition(`${id}-gain`, instrumentId, field, 'gt', m);
    const loss = holdingCondition(`${id}-loss`, instrumentId, field, 'lt', negate(m));
    return rule.side === 'gain' ? [gain] : rule.side === 'loss' ? [loss] : [gain, loss];
  }
  return undefined;
}

export function migrateV4(input: Json): { doc: Json; notes: MigrationNote[] } {
  const doc = structuredClone(input);
  const notes: MigrationNote[] = [];
  const parts: { part: Json; at: string }[] = [{ part: doc, at: '' }];
  arr(doc.groups).forEach((g, i) => {
    if (isObj(g)) parts.push({ part: g, at: `groups[${i}].` });
  });
  for (const { part, at } of parts) {
    const exit = isObj(part.exit) ? part.exit : undefined;
    if (!exit) continue;
    const rules = arr(exit.rules);
    const moving = rules.filter((r): r is Json => isObj(r) && String(r.kind) in LABELS);
    if (moving.length === 0) continue;
    const entry = isObj(part.entry) ? part.entry : {};
    const first = arr(entry.orders)[0];
    const instrumentId = isObj(first) ? first.instrumentId : undefined;
    const convertible = movesIntoExitWhen(doc, part, at);
    const moved = new Set<Json>();
    for (const rule of moving) {
      const label = LABELS[String(rule.kind)];
      const conditions = convertible ? conditionsFor(rule, part, instrumentId) : undefined;
      if (!conditions) {
        notes.push({
          code: 'exit_rule_kept',
          effect: 'grandfathered',
          message: `The ${label} is kept as saved and runs as before: moving it into Exit when would change when it exits`,
          where: `${at}exit.rules`,
        });
        continue;
      }
      for (const c of conditions) exit.condition = orInto(exit.condition, c);
      moved.add(rule);
      notes.push({
        code: 'exit_rule_in_exit_when',
        effect: 'same',
        message: `The ${label} is now an Exit when condition; its exits are labelled Exit condition`,
        where: `${at}exit.condition`,
      });
    }
    const rest = rules.filter((r) => !moved.has(r as Json));
    if (rest.length > 0) exit.rules = rest;
    else delete exit.rules;
  }
  doc.schemaVersion = 5;
  return { doc, notes };
}
