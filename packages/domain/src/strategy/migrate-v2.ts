import Decimal from 'decimal.js';
import type { MigrationNote } from './migrate-v1';

/**
 * Schema version 2 → 3: What to trade, Entry, Exit (ADR 0073).
 *
 * Stored versions are never rewritten; every read of a version 2 document
 * goes through `migrateV2`, which gives the same strategy in the new shape
 * and a note per conversion, as `migrateV1` does (ADR 0049). Every
 * conversion keeps the strategy's behaviour exactly:
 *
 * - A Selection group becomes What to trade = a group: its universe, its
 *   pre-filter as the filter, its ranking, direction and count as the ranking.
 *   Without "Keep each pick until its own exit" Exit gains the "Left the
 *   group" rule, which is the rebalance exit it had. A fixed count of N turns
 *   the template leg's total into the amount per pick (total ÷ N, to the 10
 *   decimal places the engines divided to); a percentage count keeps the
 *   total, split equally (`splitTotal`), because N then depends on the
 *   universe's size.
 * - Anything else becomes What to trade = specific assets (its legs').
 *   Per-leg conditions and a Selection group of these legs are kept as saved
 *   (`rankedLegs`): they run exactly as before, but the builder no longer
 *   offers them.
 * - The schedule moves into Entry. Exit gets no schedule, which means "on
 *   every bar the run steps on", as before.
 *
 * Works on plain JSON, before the schema parses it.
 */

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function migrateV2(input: Json): { doc: Json; notes: MigrationNote[] } {
  const doc = structuredClone(input);
  const notes: MigrationNote[] = [];
  const entry = isObj(doc.entry) ? doc.entry : {};
  const exit = isObj(doc.exit) ? doc.exit : {};
  const sel = isObj(entry.selection) ? entry.selection : undefined;
  const universe = sel && isObj(sel.universe) ? sel.universe : undefined;
  const isGroup = entry.kind === 'selection' && !!sel && universe?.type !== 'legs';

  if (isGroup && sel && universe) {
    const count = isObj(sel.count) ? sel.count : { type: 'fixed', value: 1 };
    const ranking = isObj(sel.ranking) ? sel.ranking : { metric: '', params: {} };
    const trade: Json = {
      kind: 'group',
      universe,
      ranking: {
        metric: ranking.metric,
        params: ranking.params ?? {},
        direction: sel.direction ?? 'desc',
        count,
      },
    };
    if (isObj(sel.preFilter)) trade.filter = sel.preFilter;
    notes.push({
      code: 'trade_group',
      effect: 'same',
      message:
        'The Selection group is now What to trade: a group, with its pre-filter as the filter and its ranking',
      where: 'trade',
    });
    if (count.type === 'fixed' && Number(count.value) > 1) {
      const n = Number(count.value);
      arr(entry.orders).forEach((o, i) => {
        if (!isObj(o) || !isObj(o.quantity)) return;
        const q = o.quantity;
        const total = String(q.value);
        try {
          q.value = new Decimal(total).div(n).toDecimalPlaces(10).toString();
        } catch {
          return;
        }
        notes.push({
          code: 'per_pick_amount',
          effect: 'same',
          message: `The total of ${total} split over ${n} picks is now ${String(q.value)} per pick`,
          where: `entry.orders[${i}].quantity`,
        });
      });
    } else if (count.type === 'percent') {
      trade.splitTotal = true;
      notes.push({
        code: 'split_total_kept',
        effect: 'same',
        message:
          'The Entry amount stays a total split equally, because a percentage count depends on the universe size',
        where: 'trade.splitTotal',
      });
    }
    if (sel.keepHoldings !== true) {
      const rules = arr(exit.rules);
      exit.rules = [...rules, { kind: 'leftGroup', id: 'left-group' }];
      notes.push({
        code: 'left_group_rule',
        effect: 'same',
        message:
          'Holdings that leave the top N are sold at the next Entry check, as before: this is now the "Left the group" exit rule',
        where: 'exit.rules',
      });
    }
    doc.trade = trade;
  } else {
    doc.trade = { kind: 'assets' };
    notes.push({
      code: 'trade_assets',
      effect: 'same',
      message: 'What to trade is the specific assets the Entry legs trade',
      where: 'trade',
    });
    if (sel && universe?.type === 'legs') {
      const rankedLegs: Json = {
        metric: isObj(sel.ranking) ? sel.ranking.metric : '',
        params: isObj(sel.ranking) ? (sel.ranking.params ?? {}) : {},
        direction: sel.direction ?? 'desc',
        count: sel.count,
      };
      if (isObj(sel.preFilter)) rankedLegs.preFilter = sel.preFilter;
      entry.rankedLegs = rankedLegs;
      notes.push({
        code: 'ranked_legs_kept',
        effect: 'grandfathered',
        message:
          'The Entry legs ranked by a metric are kept as saved and run as before; the builder no longer offers this form',
        where: 'entry.rankedLegs',
      });
    }
    if (arr(entry.orders).some((o) => isObj(o) && isObj(o.legCondition)))
      notes.push({
        code: 'leg_conditions_kept',
        effect: 'grandfathered',
        message:
          'Per-leg conditions are kept as saved and run as before; the builder no longer offers them for new legs',
        where: 'entry.orders',
      });
  }
  delete entry.kind;
  delete entry.selection;

  if (isObj(doc.schedule)) {
    entry.schedule = doc.schedule;
    notes.push({
      code: 'schedule_moved',
      effect: 'same',
      message: 'The schedule is now Check Entry, in Entry',
      where: 'entry.schedule',
    });
  }
  delete doc.schedule;
  doc.entry = entry;
  doc.exit = exit;
  doc.schemaVersion = 3;
  return { doc, notes };
}
