import type { PhaseName, PlannedOrder, StrategyDefinition, Timing } from './schema';

/**
 * Timing dependencies between legs (Design v1.0 §6.8). A relative timing rule
 * waits on an event; when that event belongs to another leg, the leg depends on
 * it. Entry legs run before any Exit leg, so they may only wait on the Entry
 * trigger or on other Entry legs.
 */

export const UNIT_SECONDS = { s: 1, min: 60, h: 3600, d: 86_400 } as const;

export function relativeDelaySeconds(timing: Extract<Timing, { mode: 'relative' }>): number {
  return timing.amount * UNIT_SECONDS[timing.unit];
}

export interface TimingProblem {
  legId: string;
  phase: PhaseName;
  code:
    | 'unknown_leg_reference'
    | 'self_reference'
    | 'entry_references_exit'
    | 'entry_waits_on_own_phase'
    | 'timing_cycle'
    | 'exact_time_invalid_zone';
  message: string;
}

/** Phase events an Entry leg cannot wait on, because they depend on Entry legs themselves. */
const ENTRY_DEPENDENT_EVENTS = new Set([
  'entry_submitted',
  'entry_partial_fill',
  'entry_full_fill',
  'position_opened',
]);

export function legDependencies(order: PlannedOrder): string[] {
  const t = order.timing;
  return t.mode === 'relative' && t.reference.kind === 'leg' ? [t.reference.legId] : [];
}

/** Returns each dependency cycle once, as the list of leg ids around it. */
export function findTimingCycles(orders: readonly PlannedOrder[]): string[][] {
  const deps = new Map(orders.map((o) => [o.id, legDependencies(o)]));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const seen = new Set<string>();

  const visit = (id: string) => {
    state.set(id, 'visiting');
    stack.push(id);
    for (const dep of deps.get(id) ?? []) {
      if (!deps.has(dep) || dep === id) continue; // self-references are reported separately
      if (state.get(dep) === 'visiting') {
        const cycle = stack.slice(stack.indexOf(dep));
        const key = [...cycle].sort().join(',');
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(cycle);
        }
      } else if (!state.has(dep)) {
        visit(dep);
      }
    }
    stack.pop();
    state.set(id, 'done');
  };
  for (const id of deps.keys()) if (!state.has(id)) visit(id);
  return cycles;
}

function isValidZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export function checkTiming(def: StrategyDefinition): TimingProblem[] {
  const problems: TimingProblem[] = [];
  const entryIds = new Set(def.entry.orders.map((o) => o.id));
  const exitIds = new Set(def.exit.orders.map((o) => o.id));

  for (const phase of ['entry', 'exit'] as const) {
    for (const order of def[phase].orders) {
      const t = order.timing;
      if (t.mode === 'exact' && !isValidZone(t.zone)) {
        problems.push({
          legId: order.id,
          phase,
          code: 'exact_time_invalid_zone',
          message: `"${order.legLabel}" uses an unknown time zone`,
        });
      }
      if (t.mode !== 'relative') continue;
      const ref = t.reference;
      if (ref.kind === 'phase') {
        if (phase === 'entry' && ENTRY_DEPENDENT_EVENTS.has(ref.event)) {
          problems.push({
            legId: order.id,
            phase,
            code: 'entry_waits_on_own_phase',
            message: `Entry leg "${order.legLabel}" can't wait on an Entry order event it is part of. Use the Entry trigger or another Entry leg.`,
          });
        }
        continue;
      }
      if (ref.legId === order.id) {
        problems.push({
          legId: order.id,
          phase,
          code: 'self_reference',
          message: `"${order.legLabel}" can't wait on itself`,
        });
      } else if (!entryIds.has(ref.legId) && !exitIds.has(ref.legId)) {
        problems.push({
          legId: order.id,
          phase,
          code: 'unknown_leg_reference',
          message: `"${order.legLabel}" waits on a leg that no longer exists`,
        });
      } else if (phase === 'entry' && exitIds.has(ref.legId)) {
        problems.push({
          legId: order.id,
          phase,
          code: 'entry_references_exit',
          message: `Entry leg "${order.legLabel}" can't wait on an Exit leg; Exit orders only start after Entry`,
        });
      }
    }
  }

  const all = [...def.entry.orders, ...def.exit.orders];
  const labels = new Map(all.map((o) => [o.id, o.legLabel]));
  for (const cycle of findTimingCycles(all)) {
    const first = cycle[0] as string;
    problems.push({
      legId: first,
      phase: entryIds.has(first) ? 'entry' : 'exit',
      code: 'timing_cycle',
      message: `These legs wait on each other in a loop: ${cycle.map((id) => `"${labels.get(id)}"`).join(' → ')}`,
    });
  }
  return problems;
}
