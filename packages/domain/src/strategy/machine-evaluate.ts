import { tradingDaysBetween } from '../market/calendar';
import { evaluateComparison, type SeriesResolver, type Truth } from './evaluate';
import {
  fallbackStateId,
  isStateDays,
  isUnconditional,
  type Machine,
  type MachineComparison,
  type MachineCondition,
  type MachineExpr,
  type MachineRow,
} from './machine-schema';
import type { Comparison, Expr } from './schema';

/**
 * Evaluation of a state machine's rows (state-machine brief v1.3 §2.1–§2.2,
 * §2.7; ADR 0124 P2a). Pure: the back test, the paper runtime and Start's
 * replay all call `decideDay`, so the rules can't drift between them.
 */

/** One switch of state, as the transition records keep it (§2.6). */
export interface StateSwitch {
  /** The bar (session) date of the close that decided it. */
  on: string;
  fromStateId: string;
  toStateId: string;
}

/** What the state operands read on one evaluation (§2.1). */
export interface MachineView {
  /** The state held coming into this evaluation. */
  current: string;
  /** The state held before current; undefined before the first switch. */
  prior: string | undefined;
  /** Days in current, the entry day counting as day 1. */
  daysInState: number;
  /** Days in any of `stateIds`, cumulative across moves within the set; 0 outside it. */
  daysInStates(stateIds: readonly string[]): number;
}

/**
 * The view for evaluating on `today`, derived from the switches (oldest
 * first) and the day the run started, never from a stored counter, so pauses
 * and missed passes can't change it (§2). `sessions(a, b)` counts sessions
 * after a up to b; NYSE trading days by default.
 */
export function machineView(
  start: { stateId: string; on: string },
  switches: readonly StateSwitch[],
  today: string,
  sessions: (from: string, to: string) => number = tradingDaysBetween,
): MachineView {
  const last = switches[switches.length - 1];
  const current = last ? last.toStateId : start.stateId;
  const days = (from: string) => sessions(from, today) + 1;
  return {
    current,
    prior: last?.fromStateId,
    daysInState: days(last ? last.on : start.on),
    daysInStates(stateIds) {
      const set = new Set(stateIds);
      if (!set.has(current)) return 0;
      // Walk back while the run came from inside the set (brief v1.3 build note).
      for (let i = switches.length - 1; i >= 0; i--) {
        const s = switches[i] as StateSwitch;
        if (!set.has(s.fromStateId)) return days(s.on);
      }
      return days(start.on);
    },
  };
}

export interface RowEnv {
  view: MachineView;
  resolver: SeriesResolver;
  rows: ReadonlyMap<string, MachineRow>;
}

function stateDays(e: MachineExpr, view: MachineView): number | undefined {
  if (e.kind === 'days_in_state') return view.daysInState;
  if (e.kind === 'days_in_states') return view.daysInStates(e.stateIds);
  return undefined;
}

/**
 * A comparison with a state-day count on a side: the count is read once and
 * stands in as a constant, so the usual comparison code compares it.
 */
function compareWithDays(c: MachineComparison, env: RowEnv): Truth {
  const side = (e: MachineExpr | undefined): Expr | undefined => {
    if (!e || !isStateDays(e)) return e as Expr | undefined;
    const n = stateDays(e, env.view);
    return { kind: 'constant', id: e.id, value: String(n) };
  };
  const plain: Comparison = {
    kind: 'comparison',
    id: c.id,
    left: side(c.left) as Expr,
    operator: c.operator,
    ...(c.right ? { right: side(c.right) } : {}),
    ...(c.upper ? { upper: side(c.upper) } : {}),
  };
  return evaluateComparison(plain, env.resolver);
}

/** Three-valued, exactly as `evaluateCondition` (unknown never qualifies). */
export function evaluateMachineCondition(
  node: MachineCondition,
  env: RowEnv,
  seen: ReadonlySet<string> = new Set(),
): Truth {
  switch (node.kind) {
    case 'state_is': {
      const id = node.which === 'current' ? env.view.current : env.view.prior;
      return id !== undefined && node.stateIds.includes(id);
    }
    case 'row_ref': {
      // Validation refuses cycles; a cycle met anyway is unknown, never a loop.
      const row = env.rows.get(node.rowId);
      if (!row || seen.has(node.rowId)) return undefined;
      return rowTruth(row, env, new Set([...seen, node.rowId]));
    }
    case 'comparison':
      return isStateDays(node.left) || isStateDays(node.right) || isStateDays(node.upper)
        ? compareWithDays(node, env)
        : evaluateComparison(node as Comparison, env.resolver);
    case 'group': {
      if (node.children.length === 0) return undefined;
      const results = node.children.map((c) => evaluateMachineCondition(c, env, seen));
      const value: Truth =
        node.op === 'and'
          ? results.includes(false)
            ? false
            : results.includes(undefined)
              ? undefined
              : true
          : results.includes(true)
            ? true
            : results.includes(undefined)
              ? undefined
              : false;
      return node.negate && value !== undefined ? !value : value;
    }
  }
}

/** A row's rule: always true when it has none (the fallback row). */
export function rowTruth(
  row: MachineRow,
  env: RowEnv,
  seen: ReadonlySet<string> = new Set(),
): Truth {
  if (isUnconditional(row) || !row.condition) return true;
  return evaluateMachineCondition(row.condition, env, new Set([...seen, row.id]));
}

export type DayDecision =
  | { kind: 'switch'; rowId: string; toStateId: string }
  | {
      kind: 'stay';
      /**
       * `row`: a stay row won; `same_state`: the winning row names the current
       * state; `unknown`: a row above any true row was unknown (§2.2);
       * `no_row`: no row was true.
       */
      reason: 'row' | 'same_state' | 'unknown' | 'no_row';
      rowId?: string;
    };

/**
 * Today's decision (§2, §2.2): rows tested from the top, the first true row
 * decides, and an unknown row above it makes the day a stay, so a missing bar
 * or an undefined metric never lets a lower row win.
 */
export function decideDay(
  machine: Machine,
  view: MachineView,
  resolver: SeriesResolver,
): DayDecision {
  const env: RowEnv = { view, resolver, rows: new Map(machine.rows.map((r) => [r.id, r])) };
  for (const row of machine.rows) {
    const truth = rowTruth(row, env);
    if (truth === undefined) return { kind: 'stay', reason: 'unknown', rowId: row.id };
    if (!truth) continue;
    if (row.outcome.kind === 'stay') return { kind: 'stay', reason: 'row', rowId: row.id };
    if (row.outcome.stateId === view.current)
      return { kind: 'stay', reason: 'same_state', rowId: row.id };
    return { kind: 'switch', rowId: row.id, toStateId: row.outcome.stateId };
  }
  return { kind: 'stay', reason: 'no_row' };
}

export interface ReplayStep {
  on: string;
  /** The state held coming into the day. */
  current: string;
  decision: DayDecision;
}

export interface Replay {
  startStateId: string;
  switches: StateSwitch[];
  steps: ReplayStep[];
  /** The state held after the last day. */
  finalStateId: string;
}

/**
 * The state path over a run of daily bars, with no orders (§2.7, §2.9): the
 * run starts in the fallback state on the first day, and each day's decision
 * reads the bars up to that day only. `resolverAt(i)` answers for day i.
 * Days are counted in the given list's sessions, so the path never depends on
 * a calendar outside the bars.
 */
export function replayMachine(
  machine: Machine,
  days: readonly string[],
  resolverAt: (i: number) => SeriesResolver,
): Replay {
  const startStateId = fallbackStateId(machine);
  if (!startStateId)
    throw new Error('A state machine needs an unconditional last row naming a state');
  const index = new Map(days.map((d, i) => [d, i]));
  const sessions = (a: string, b: string) => (index.get(b) ?? 0) - (index.get(a) ?? 0);
  const switches: StateSwitch[] = [];
  const steps: ReplayStep[] = [];
  const start = { stateId: startStateId, on: days[0] ?? '' };
  days.forEach((on, i) => {
    const view = machineView(start, switches, on, sessions);
    const decision = decideDay(machine, view, resolverAt(i));
    steps.push({ on, current: view.current, decision });
    if (decision.kind === 'switch')
      switches.push({ on, fromStateId: view.current, toStateId: decision.toStateId });
  });
  const last = switches[switches.length - 1];
  return { startStateId, switches, steps, finalStateId: last ? last.toStateId : startStateId };
}
