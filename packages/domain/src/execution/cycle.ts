import Decimal from 'decimal.js';
import { nextTradingDay, nyDate, regularSession } from '../market/calendar';
import type { Truth } from '../strategy/evaluate';
import type { PhaseEvent, PhaseName, PlannedOrder, StrategyDefinition } from '../strategy/schema';
import { extendedHoursEligible } from '../strategy/extended-hours';
import { relativeDelaySeconds } from '../strategy/timing';
import { timeStopReached } from '../strategy/schedule';
import type { Slot as StrategySlot } from '../strategy/selection';
import type { OrderState } from './order-state';
import type { Direction } from './sizing';
import { initialTriggerState, stepTrigger, type TriggerState } from './trigger';

/**
 * The Entry-first, Exit-second cycle (Design v1.0 §6.7–6.9) as a pure planner.
 * The paper runtime rebuilds a cycle's state from its durable records on every
 * pass and asks `planCycle` what to do next, so a restarted worker makes the
 * same decisions and never places a leg twice. It follows the same rules as
 * the back-test engine: timing, multi-leg policies and timeouts, the Entry
 * milestone, and re-arming Exit while something is still held.
 */

export type LegPhase = PhaseName | 'flatten';
export type CycleStatus = 'entry_working' | 'open' | 'exit_working' | 'closed' | 'aborted';

/** One placed order of a cycle, as recorded. */
export interface LegRecord {
  legId: string;
  phase: LegPhase;
  /** Entry batch (pyramiding) or Exit round; 1 for the first. */
  attempt: number;
  intentId: string;
  instrumentId: string;
  direction: Direction;
  state: OrderState;
  quantity: Decimal;
  filled: Decimal;
  /** Epoch ms when the order became eligible and was placed. */
  placedAt: number;
  /** When it could first trade: placement, or the next open if the market was closed. */
  activeFrom: number;
  firstFillAt?: number | undefined;
  filledAt?: number | undefined;
  cancelRequested: boolean;
}

/** What the runtime stores for a cycle between passes. */
export interface CycleState {
  status: CycleStatus;
  entryTriggeredAt?: number | undefined;
  /** Trigger time of the current Exit round. */
  exitTriggeredAt?: number | undefined;
  positionOpenedAt?: number | undefined;
  entryBatches: number;
  exitRound: number;
  /** Keys of legs that will never be placed (see `legKey`). */
  skipped: string[];
  flattened: boolean;
  exitTrigger: TriggerState;
  /** The universe member or leg this cycle holds (v1.2 Selection groups and per-leg conditions). */
  slot?: StrategySlot | undefined;
  /** Why the current Exit round started, when not the Exit condition (v1.2). */
  exitReason?: 'rebalance' | 'time_stop' | undefined;
}

export const legKey = (phase: LegPhase, legId: string, attempt: number) =>
  `${phase}:${legId}:${attempt}`;

export function newCycleState(entryTriggeredAt: number | undefined): CycleState {
  return {
    status: 'entry_working',
    entryTriggeredAt,
    entryBatches: 1,
    exitRound: 1,
    skipped: [],
    flattened: false,
    exitTrigger: initialTriggerState(false),
  };
}

export type LegReference =
  | { kind: 'trigger'; phase: PhaseName }
  | { kind: 'event'; event: PhaseEvent; legKey?: string | undefined }
  | { kind: 'leg'; legKey: string; event: 'submitted' | 'filled' }
  | { kind: 'time' };

export interface PlannedLeg {
  key: string;
  legId: string;
  phase: PhaseName;
  attempt: number;
  /** When the leg became due, epoch ms. */
  dueAt: number;
  /** The durable event the due time came from (§6.8). */
  reference: LegReference;
}

export interface CycleInput {
  definition: StrategyDefinition;
  cycle: CycleState;
  legs: readonly LegRecord[];
  /** Signed quantity held per instrument from this cycle's fills. */
  positions: ReadonlyMap<string, Decimal>;
  now: number;
  /** Truth of the Exit condition on data that is new since the last pass. */
  exitTruth?: { truth: Truth } | undefined;
  /** Exit now because a rebalance no longer selects this slot (v1.2 items 1, 2). */
  forceExit?: 'rebalance' | undefined;
}

export interface CyclePlan {
  cycle: CycleState;
  /** Legs to size, risk-check and place now. */
  submit: PlannedLeg[];
  /** Legs that will become due later, with their due time. */
  scheduled: PlannedLeg[];
  cancel: { intentId: string; reason: 'leg_timeout' | 'leg_failed' }[];
  /** Create closing orders for whatever the cycle still holds. */
  flatten: boolean;
  /** Notable things for the timeline and notifications. */
  notes: CycleNote[];
  /** Phase event times known so far. */
  events: Partial<Record<PhaseEvent, number>>;
}

export type CycleNote =
  | 'entry_triggered_exit'
  | 'position_opened'
  | 'entry_incomplete'
  | 'exit_triggered'
  | 'exit_incomplete'
  | 'leg_failed'
  | 'flattening'
  | 'closed'
  | 'aborted';

type LegStatus = 'waiting' | 'working' | 'filled' | 'partial' | 'failed' | 'canceled' | 'skipped';
const DONE: readonly LegStatus[] = ['filled', 'partial', 'failed', 'canceled', 'skipped'];

function statusOf(r: LegRecord | undefined, skipped: boolean): LegStatus {
  if (!r) return skipped ? 'skipped' : 'waiting';
  switch (r.state) {
    case 'filled':
      return 'filled';
    case 'canceled':
    case 'expired':
      return r.filled.gt(0) ? 'partial' : 'canceled';
    case 'rejected':
    case 'failed':
      return r.filled.gt(0) ? 'partial' : 'failed';
    default:
      return 'working';
  }
}

/** Legs of a phase in submission order (§6.7). */
export function legOrderFor(def: StrategyDefinition, phase: PhaseName): PlannedOrder[] {
  const orders = def[phase].orders;
  if (def.execution.multiLegPolicy === 'concurrent' || !def.execution.legOrder) return orders;
  const rank = new Map(def.execution.legOrder.map((id, i) => [id, i]));
  return [...orders].sort(
    (a, b) =>
      (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
  );
}

/**
 * Whether a leg is sent as an extended-hours order (§6.8). A leg that asks for
 * extended hours always is. Under the "extended hours if supported" policy, a
 * leg placed outside the regular session is too, when its account trades
 * extended hours and the order is one brokers take there: a day limit order.
 * Anything else waits for the regular session, as under "queue".
 */
export function sendsExtendedHours(
  order: Pick<PlannedOrder, 'extendedHours' | 'orderType' | 'timeInForce'>,
  policy: StrategyDefinition['execution']['marketHoursPolicy'],
  regularSessionOpen: boolean,
  accountExtendedHours: boolean,
): boolean {
  if (order.extendedHours) return true;
  return (
    policy === 'extended_if_supported' &&
    !regularSessionOpen &&
    extendedHoursEligible(order, accountExtendedHours)
  );
}

/** Whether the regular NYSE session is open at `t`. */
export function regularSessionOpenAt(t: number): boolean {
  const session = regularSession(nyDate(new Date(t)));
  return !!session && t >= Date.parse(session.open) && t < Date.parse(session.close);
}

/** When an order placed at `t` can first trade, under the market-hours policy. */
export function activeFromFor(
  t: number,
  policy: StrategyDefinition['execution']['marketHoursPolicy'],
): number | undefined {
  const day = nyDate(new Date(t));
  const session = regularSession(day);
  if (session && t >= Date.parse(session.open) && t < Date.parse(session.close)) return t;
  if (policy === 'cancel') return undefined;
  const next =
    session && t < Date.parse(session.open) ? session : regularSession(nextTradingDay(day));
  return next ? Date.parse(next.open) : undefined;
}

interface Slot {
  order: PlannedOrder;
  phase: PhaseName;
  attempt: number;
  key: string;
  record: LegRecord | undefined;
  status: LegStatus;
}

export function planCycle(input: CycleInput): CyclePlan {
  const { definition: def, legs, positions, now } = input;
  const ex = def.execution;
  const cycle: CycleState = structuredClone(input.cycle);
  const plan: CyclePlan = {
    cycle,
    submit: [],
    scheduled: [],
    cancel: [],
    flatten: false,
    notes: [],
    events: {},
  };
  const byKey = new Map(legs.map((l) => [legKey(l.phase, l.legId, l.attempt), l]));
  const skipped = new Set(cycle.skipped);
  const slot = (order: PlannedOrder, phase: PhaseName, attempt: number): Slot => {
    const key = legKey(phase, order.id, attempt);
    const record = byKey.get(key);
    return { order, phase, attempt, key, record, status: statusOf(record, skipped.has(key)) };
  };
  const entrySlots = (): Slot[] => {
    const out: Slot[] = [];
    for (let b = 1; b <= cycle.entryBatches; b++)
      for (const o of legOrderFor(def, 'entry')) out.push(slot(o, 'entry', b));
    return out;
  };
  const exitSlots = (): Slot[] =>
    legOrderFor(def, 'exit').map((o) => slot(o, 'exit', cycle.exitRound));
  const flattenLegs = legs.filter((l) => l.phase === 'flatten');
  const flattenDone = flattenLegs.every((l) => DONE.includes(statusOf(l, false)));
  const flat = () => [...positions.values()].every((q) => q.isZero());

  // Phase events from the records (§6.8 reference events).
  const entryRecords = legs.filter((l) => l.phase === 'entry');
  const min = (xs: (number | undefined)[]) => {
    const v = xs.filter((x): x is number => x !== undefined);
    return v.length ? Math.min(...v) : undefined;
  };
  const events = plan.events;
  if (cycle.entryTriggeredAt !== undefined) events.entry_trigger = cycle.entryTriggeredAt;
  const submitted = min(entryRecords.map((l) => l.placedAt));
  if (submitted !== undefined) events.entry_submitted = submitted;
  const partial = min(entryRecords.map((l) => l.firstFillAt));
  if (partial !== undefined) events.entry_partial_fill = partial;
  const allEntry = entrySlots();
  if (allEntry.length > 0 && allEntry.every((s) => s.status === 'filled')) {
    events.entry_full_fill = Math.max(...allEntry.map((s) => s.record?.filledAt ?? now));
  }
  if (cycle.positionOpenedAt !== undefined) events.position_opened = cycle.positionOpenedAt;

  const legEvent = (legId: string, event: 'submitted' | 'filled'): [number, string] | undefined => {
    // The latest placement of that leg in this cycle.
    const recs = legs
      .filter((l) => l.legId === legId && l.phase !== 'flatten')
      .sort((a, b) => b.attempt - a.attempt || (a.phase === 'exit' ? -1 : 1));
    const r = recs[0];
    if (!r) return undefined;
    const t = event === 'submitted' ? r.placedAt : r.filledAt;
    return t === undefined ? undefined : [t, legKey(r.phase, r.legId, r.attempt)];
  };

  /** Due time of a waiting leg, if its timing can be resolved yet. */
  const dueOf = (
    s: Slot,
    triggeredAt: number | undefined,
  ): { at: number; reference: LegReference } | undefined => {
    const t = s.order.timing;
    const needsTrigger = t.mode === 'immediate' || !s.order.timingOnly;
    if (needsTrigger && triggeredAt === undefined) return undefined;
    if (t.mode === 'immediate')
      return { at: triggeredAt ?? now, reference: { kind: 'trigger', phase: s.phase } };
    if (t.mode === 'exact') return { at: Date.parse(t.at), reference: { kind: 'time' } };
    const delay = relativeDelaySeconds(t) * 1000;
    if (t.reference.kind === 'phase') {
      const at = events[t.reference.event];
      return at === undefined
        ? undefined
        : { at: at + delay, reference: { kind: 'event', event: t.reference.event } };
    }
    const found = legEvent(t.reference.legId, t.reference.event);
    return found
      ? {
          at: found[0] + delay,
          reference: { kind: 'leg', legKey: found[1], event: t.reference.event },
        }
      : undefined;
  };

  const multiLeg = (phase: PhaseName) => def[phase].orders.length > 1;

  /** A leg ended without filling completely: apply the multi-leg policy (§6.7). */
  const onLegProblem = (slots: Slot[], failed: Slot) => {
    if (!multiLeg(failed.phase)) return;
    if (!plan.notes.includes('leg_failed')) plan.notes.push('leg_failed');
    if (ex.onLegFailure === 'leave_and_alert') return;
    for (const other of slots) {
      if (other === failed) continue;
      if (other.status === 'waiting') {
        skipped.add(other.key);
        other.status = 'skipped';
      }
      if (other.status === 'working' && other.record && !other.record.cancelRequested) {
        if (!plan.cancel.some((c) => c.intentId === other.record?.intentId))
          plan.cancel.push({ intentId: other.record.intentId, reason: 'leg_failed' });
      }
    }
    if (ex.onLegFailure === 'flatten_filled' && !cycle.flattened) {
      cycle.flattened = true;
      plan.flatten = true;
      plan.notes.push('flattening');
    }
  };

  const handleProblems = (slots: Slot[]) => {
    for (const s of slots) {
      if (s.status === 'partial' || s.status === 'failed' || s.status === 'canceled')
        onLegProblem(slots, s);
    }
  };

  // 1. Leg timeouts on multi-leg phases (§6.7, decision of 2026-10-04: 60 s then cancel).
  for (const s of [...allEntry, ...exitSlots()]) {
    const r = s.record;
    if (s.status !== 'working' || !r || r.cancelRequested || !multiLeg(s.phase)) continue;
    if (now - r.activeFrom > ex.legTimeoutSec * 1000)
      plan.cancel.push({ intentId: r.intentId, reason: 'leg_timeout' });
  }

  // 2. Failed legs, then due legs.
  const schedule = (slots: Slot[], triggeredAt: number | undefined) => {
    handleProblems(slots);
    let prev: Slot | undefined;
    for (const s of slots) {
      const blockedByPrev =
        prev !== undefined &&
        ((ex.multiLegPolicy === 'after_prior_fill' && prev.status !== 'filled') ||
          (ex.multiLegPolicy === 'sequential' && prev.status === 'waiting'));
      if (s.status === 'waiting' && !blockedByPrev) {
        const due = dueOf(s, triggeredAt);
        if (due) {
          const leg: PlannedLeg = {
            key: s.key,
            legId: s.order.id,
            phase: s.phase,
            attempt: s.attempt,
            dueAt: due.at,
            reference: due.reference,
          };
          if (due.at <= now) {
            plan.submit.push(leg);
            // Placed this pass, so later sequential legs are no longer blocked by it.
            s.status = 'working';
          } else plan.scheduled.push(leg);
        }
      }
      prev = s;
    }
  };

  if (cycle.status !== 'closed' && cycle.status !== 'aborted') {
    schedule(allEntry, cycle.entryTriggeredAt);
  }

  // 3. Settle Entry: the milestone opens the position (§6.9).
  const settleEntry = () => {
    const slots = entrySlots().map((s) => {
      const placed = plan.submit.find((p) => p.key === s.key);
      return placed ? { ...s, status: 'working' as LegStatus } : s;
    });
    const done = slots.every((s) => DONE.includes(s.status));
    const anyFill = slots.some((s) => (s.record?.filled ?? new Decimal(0)).gt(0));
    if (cycle.status === 'entry_working') {
      if (done && !anyFill && flattenLegs.length === 0) {
        cycle.status = 'aborted';
        plan.notes.push('aborted');
        return;
      }
      const milestone = ex.entryMilestone === 'partial_fill' ? anyFill : done && anyFill;
      if (milestone) {
        cycle.status = 'open';
        const lastFill = Math.max(
          0,
          ...slots.map((s) => s.record?.filledAt ?? s.record?.firstFillAt ?? 0),
        );
        cycle.positionOpenedAt = lastFill || now;
        events.position_opened = cycle.positionOpenedAt;
        plan.notes.push('position_opened');
        if (
          slots.some(
            (s) => s.status === 'partial' || s.status === 'failed' || s.status === 'canceled',
          )
        )
          plan.notes.push('entry_incomplete');
      }
    }
  };
  settleEntry();

  // 4. Exit: watch the condition once the position is open, then place Exit legs.
  if (cycle.status === 'open' && input.exitTruth) {
    if (stepTrigger(cycle.exitTrigger, input.exitTruth.truth, now, def.exit.trigger)) {
      cycle.status = 'exit_working';
      cycle.exitTriggeredAt = now;
      plan.notes.push('exit_triggered');
    }
  }
  // A rebalance or the time stop exits too, by OR with the condition (v1.2).
  if (cycle.status === 'open') {
    const reason = input.forceExit
      ? input.forceExit
      : timeStopReached(def, events.entry_partial_fill, now)
        ? 'time_stop'
        : undefined;
    if (reason) {
      cycle.status = 'exit_working';
      cycle.exitTriggeredAt = now;
      cycle.exitReason = reason;
      plan.notes.push('exit_triggered');
    }
  }
  if (cycle.status === 'open' || cycle.status === 'exit_working') {
    const slots = exitSlots();
    schedule(slots, cycle.status === 'exit_working' ? cycle.exitTriggeredAt : undefined);
    // A timing-only Exit leg can go before the Exit condition does.
    if (
      cycle.status === 'open' &&
      slots.some((s) => s.status !== 'waiting' && s.status !== 'skipped')
    )
      cycle.status = 'exit_working';
  }

  // 5. Close, or re-arm Exit while something is still held.
  if (cycle.status === 'open' || cycle.status === 'exit_working') {
    const exits = exitSlots().map((s) =>
      plan.submit.some((p) => p.key === s.key) ? { ...s, status: 'working' as LegStatus } : s,
    );
    const exitDone = exits.length > 0 && exits.every((s) => DONE.includes(s.status));
    const entryDone = entrySlots().every(
      (s) => DONE.includes(s.status) && !plan.submit.some((p) => p.key === s.key),
    );
    if (
      flat() &&
      entryDone &&
      flattenDone &&
      !plan.flatten &&
      (exitDone || flattenLegs.length > 0)
    ) {
      cycle.status = 'closed';
      plan.notes.push('closed');
    } else if (cycle.status === 'exit_working' && exitDone && flattenDone && !plan.flatten) {
      cycle.status = 'open';
      cycle.exitRound += 1;
      cycle.exitTriggeredAt = undefined;
      cycle.exitTrigger = initialTriggerState(false);
      plan.notes.push('exit_incomplete');
    }
  }
  if (
    cycle.status === 'entry_working' &&
    flattenLegs.length > 0 &&
    flattenDone &&
    !plan.flatten &&
    flat()
  ) {
    cycle.status = 'closed';
    plan.notes.push('closed');
  }

  cycle.skipped = [...skipped];
  return plan;
}

// ---------------------------------------------------------------------------
// Entry at the runtime level: whether a trigger starts a new cycle (§6.9).
// ---------------------------------------------------------------------------

export interface RuntimeTriggerState {
  entryTrigger: TriggerState;
  /** Timing-only exact Entry legs already used to open a cycle. */
  exactUsed: string[];
}

export const newRuntimeTriggerState = (): RuntimeTriggerState => ({
  entryTrigger: initialTriggerState(),
  exactUsed: [],
});

export interface EntryInput {
  definition: StrategyDefinition;
  state: RuntimeTriggerState;
  /** Active cycles, oldest first. */
  active: readonly { id: string; cycle: CycleState }[];
  now: number;
  /** Truth of the Entry condition on new data, if there is any. */
  entryTruth?: { truth: Truth } | undefined;
  /** New entries are halted (daily loss, drawdown, kill switch or pause). */
  halted: boolean;
}

export type EntryDecision =
  | { kind: 'none' }
  | { kind: 'new_cycle'; triggered: boolean }
  | { kind: 'add_batch'; cycleId: string };

export function planEntry(input: EntryInput): {
  state: RuntimeTriggerState;
  decision: EntryDecision;
} {
  const { definition: def, active, now } = input;
  const state = structuredClone(input.state);
  let decision: EntryDecision = { kind: 'none' };
  const fires = input.entryTruth
    ? stepTrigger(state.entryTrigger, input.entryTruth.truth, now, def.entry.trigger)
    : false;
  if (fires && !input.halted) {
    const mode = def.execution.reentry.mode;
    const current = active.at(-1);
    if (active.length === 0 || mode === 'independent_cycles') {
      decision = { kind: 'new_cycle', triggered: true };
    } else if (
      mode === 'pyramid' &&
      current &&
      current.cycle.status === 'open' &&
      current.cycle.entryBatches < (def.execution.reentry.cap ?? 1)
    ) {
      decision = { kind: 'add_batch', cycleId: current.id };
    }
  }
  if (decision.kind === 'none' && active.length === 0 && !input.halted) {
    const due = def.entry.orders.find(
      (o) =>
        o.timingOnly &&
        o.timing.mode === 'exact' &&
        !state.exactUsed.includes(o.id) &&
        now >= Date.parse(o.timing.at),
    );
    if (due) {
      state.exactUsed.push(due.id);
      decision = { kind: 'new_cycle', triggered: false };
    }
  }
  return { state, decision };
}
