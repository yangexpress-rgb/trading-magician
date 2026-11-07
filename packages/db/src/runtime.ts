import { strategyInstruments, type InstrumentRef } from '@tm/backtest';
import {
  listMembers,
  activeFromFor,
  newRuntimeTriggerState,
  parseDefinition,
  transitionOrder,
  type CycleState,
  type CycleStatus,
  type LegRecord,
  type OrderState,
  type PhaseName,
  type RuntimeTriggerState,
  type StrategyDefinition,
} from '@tm/domain';
import Decimal from 'decimal.js';
import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { recordAudit } from './audit';
import type { Database, Transaction } from './client';
import { OrderError } from './orders';
import {
  brokerOrders,
  brokerSyncs,
  executionControls,
  fills,
  instruments,
  orderEvents,
  orderIntents,
  scheduledActions,
  strategies,
  strategyCycles,
  strategyRuntimes,
  strategyVersions,
  triggerEvents,
} from './schema';

/**
 * Durable state of paper runtimes (Design v1.0 §6.5–6.9, §8.1, §13.3; ADR 0012).
 *
 * A worker leases a runtime with `claimRuntimes`, then reads everything it
 * needs with `loadRuntimeWork` and writes its decisions back inside the
 * runtime's tenant. Every decision is rebuilt from these records on each pass,
 * so a restarted worker carries on where the last one stopped.
 */

/** Paper capital each runtime starts with, for sizing and buying power (ADR 0012). */
export const PAPER_STARTING_CAPITAL = '100000';

export interface RuntimeState {
  trigger: RuntimeTriggerState;
  /** End of the newest bar evaluated, epoch ms; conditions run once per new bar. */
  lastDataTime?: number | undefined;
  /** New York date and equity at its first pass, for the daily loss limit. */
  day?: { date: string; startEquity: string } | undefined;
  peakEquity?: string | undefined;
  /** Since when the broker has not answered, epoch ms (§8.6 automatic pause). */
  brokerDownSince?: number | undefined;
  /** Since when a price used by the rules has been stale or missing, epoch ms. */
  staleSince?: number | undefined;
  /** The calendar period last evaluated on a non-daily schedule, e.g. "2026-03" (v1.2 item 4). */
  lastSchedulePeriod?: string | undefined;
  /** Entry trigger state of each further entry group, by group id (v1.2 item 8). */
  groupTriggers?: Record<string, RuntimeTriggerState> | undefined;
}

export interface WorkingOrder {
  intent: typeof orderIntents.$inferSelect;
  state: OrderState;
  brokerOrderId: string | null;
  cancelRequested: boolean;
  symbol: string;
}

export const WORKING_STATES = ['ready', 'submitted', 'acknowledged', 'partially_filled'] as const;

// ---------------------------------------------------------------------------
// Start, stop, kill switch
// ---------------------------------------------------------------------------

export async function createRuntime(
  tx: Transaction,
  userId: string,
  strategyId: string,
  versionId: string,
): Promise<string> {
  const state: RuntimeState = { trigger: newRuntimeTriggerState() };
  const [row] = await tx
    .insert(strategyRuntimes)
    .values({ userId, strategyId, versionId, startedBy: userId, state })
    .returning({ id: strategyRuntimes.id });
  if (!row) throw new Error('Failed to create the runtime');
  return row.id;
}

/**
 * Stops a strategy's runtime: no new orders. Working orders and positions stay
 * as they are (§8.1); scheduled legs that were not yet placed are dropped.
 */
export async function stopRuntime(
  tx: Transaction,
  userId: string,
  strategyId: string,
): Promise<string | undefined> {
  const [row] = await tx
    .update(strategyRuntimes)
    .set({
      status: 'stopped',
      stoppedAt: new Date(),
      stoppedBy: userId,
      rowVersion: sql`${strategyRuntimes.rowVersion} + 1`,
    })
    .where(
      and(
        eq(strategyRuntimes.strategyId, strategyId),
        sql`${strategyRuntimes.status} <> 'stopped'`,
      ),
    )
    .returning({ id: strategyRuntimes.id });
  if (!row) return undefined;
  await tx
    .update(scheduledActions)
    .set({ status: 'canceled', doneAt: new Date() })
    .where(and(eq(scheduledActions.runtimeId, row.id), eq(scheduledActions.status, 'pending')));
  return row.id;
}

export async function isHalted(tx: Transaction, userId: string): Promise<boolean> {
  const [row] = await tx
    .select({ haltedAt: executionControls.haltedAt })
    .from(executionControls)
    .where(eq(executionControls.userId, userId));
  return Boolean(row?.haltedAt);
}

/**
 * The kill switch (§8.1). Engaging it pauses every running runtime of the
 * user, so no new orders go out; it cancels nothing by itself. Releasing it
 * resumes nothing: each strategy is resumed on purpose.
 */
export async function setKillSwitch(
  tx: Transaction,
  userId: string,
  engaged: boolean,
  reason?: string,
): Promise<{ paused: number }> {
  const now = new Date();
  await tx
    .insert(executionControls)
    .values({
      userId,
      haltedAt: engaged ? now : null,
      haltedBy: engaged ? userId : null,
      reason: engaged ? (reason ?? null) : null,
    })
    .onConflictDoUpdate({
      target: executionControls.userId,
      set: {
        haltedAt: engaged ? now : null,
        haltedBy: engaged ? userId : null,
        reason: engaged ? (reason ?? null) : null,
      },
    });
  let paused = 0;
  if (engaged) {
    const rows = await tx
      .update(strategyRuntimes)
      .set({ status: 'paused', pauseReason: 'Kill switch engaged' })
      .where(eq(strategyRuntimes.status, 'running'))
      .returning({ id: strategyRuntimes.id });
    paused = rows.length;
  }
  await recordAudit(tx, {
    userId,
    actorType: 'user',
    action: engaged ? 'execution.kill_switch_engaged' : 'execution.kill_switch_released',
    resourceType: 'execution_control',
    resourceId: userId,
    context: { pausedRuntimes: paused, ...(reason ? { reason } : {}) },
  });
  return { paused };
}

export async function pauseRuntime(
  tx: Transaction,
  runtimeId: string,
  reason: string,
): Promise<void> {
  await tx
    .update(strategyRuntimes)
    .set({ status: 'paused', pauseReason: reason.slice(0, 500) })
    .where(and(eq(strategyRuntimes.id, runtimeId), eq(strategyRuntimes.status, 'running')));
}

/** Resumes a paused runtime, unless the kill switch is still engaged. */
export async function resumeRuntime(
  tx: Transaction,
  userId: string,
  runtimeId: string,
): Promise<boolean> {
  if (await isHalted(tx, userId)) return false;
  const rows = await tx
    .update(strategyRuntimes)
    .set({ status: 'running', pauseReason: null, resumedAt: new Date() })
    .where(and(eq(strategyRuntimes.id, runtimeId), eq(strategyRuntimes.status, 'paused')))
    .returning({ id: strategyRuntimes.id });
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Leasing
// ---------------------------------------------------------------------------

export async function claimRuntimes(
  db: Database,
  workerId: string,
  options: { leaseSeconds: number; limit: number },
): Promise<{ runtimeId: string; userId: string }[]> {
  const rows = await db.execute<{ claimed_id: string; claimed_user: string }>(
    sql`select * from claim_strategy_runtimes(${workerId}, ${options.leaseSeconds}, ${options.limit})`,
  );
  return rows.map((r) => ({ runtimeId: r.claimed_id, userId: r.claimed_user }));
}

/** Ends a pass early so the runtime is claimable again at the next poll. */
export async function releaseRuntime(tx: Transaction, runtimeId: string, workerId: string) {
  await tx
    .update(strategyRuntimes)
    .set({ leaseExpiresAt: sql`now()` })
    .where(and(eq(strategyRuntimes.id, runtimeId), eq(strategyRuntimes.leaseOwner, workerId)));
}

// ---------------------------------------------------------------------------
// Reading a runtime's state
// ---------------------------------------------------------------------------

export interface ActiveCycle {
  id: string;
  seq: number;
  cycle: CycleState;
  legs: LegRecord[];
  /** Signed quantity per instrument from this cycle's fills. */
  positions: Map<string, Decimal>;
  /** Cash flow from this cycle's fills: sales in, purchases and fees out. */
  cash: Decimal;
  /** Entry fills per instrument (quantity and cost before fees), for the average entry price. */
  entries: Map<string, { quantity: Decimal; cost: Decimal }>;
  entryTriggerEventId: string | null;
  exitTriggerEventId: string | null;
}

export interface RuntimeWork {
  id: string;
  userId: string;
  strategyId: string;
  strategyName: string;
  versionId: string;
  status: 'running' | 'paused' | 'stopped';
  /** Start or last resume; automatic pauses only look at what happened since. */
  activeSince: Date;
  state: RuntimeState;
  definition: StrategyDefinition;
  instruments: Map<string, InstrumentRef>;
  /** Accounts the strategy trades in. */
  accounts: string[];
  halted: boolean;
  cycles: ActiveCycle[];
  nextSeq: number;
  /** Every fill of the runtime, for equity and exposure. */
  book: { cash: Decimal; positions: Map<string, Decimal> };
  /** Orders of the runtime that are working or about to be. */
  working: WorkingOrder[];
}

const ZERO = new Decimal(0);

/** Reads a leased runtime. Returns undefined if this worker no longer holds the lease. */
export async function loadRuntimeWork(
  tx: Transaction,
  runtimeId: string,
  workerId: string,
): Promise<RuntimeWork | undefined> {
  const [rt] = await tx
    .select({
      runtime: strategyRuntimes,
      definition: strategyVersions.definition,
      strategyName: strategies.name,
    })
    .from(strategyRuntimes)
    .innerJoin(strategyVersions, eq(strategyVersions.id, strategyRuntimes.versionId))
    .leftJoin(strategies, eq(strategies.id, strategyRuntimes.strategyId))
    .where(eq(strategyRuntimes.id, runtimeId))
    .for('update', { of: strategyRuntimes });
  if (!rt || rt.runtime.leaseOwner !== workerId) return undefined;
  const definition = parseDefinition(rt.definition);
  const raw = rt.runtime.state as Partial<RuntimeState>;
  const state: RuntimeState = { ...raw, trigger: raw.trigger ?? newRuntimeTriggerState() };

  // Legs, condition instruments, list-universe members and benchmarks (v1.2).
  const ids = new Set<string>(strategyInstruments(definition, listMembers(definition)));
  const accounts = new Set<string>();
  for (const phase of [definition.entry, definition.exit]) {
    for (const o of phase.orders) accounts.add(o.accountId);
  }

  // Every order of the runtime, with fills.
  const orders = await tx
    .select({
      intent: orderIntents,
      state: brokerOrders.state,
      brokerOrderId: brokerOrders.brokerOrderId,
      filledQuantity: brokerOrders.filledQuantity,
      filledAt: brokerOrders.filledAt,
      cancelRequestedAt: brokerOrders.cancelRequestedAt,
    })
    .from(orderIntents)
    .innerJoin(brokerOrders, eq(brokerOrders.intentId, orderIntents.id))
    .where(eq(orderIntents.runtimeId, runtimeId))
    .orderBy(asc(orderIntents.createdAt));
  for (const o of orders) {
    ids.add(o.intent.instrumentId);
    accounts.add(o.intent.accountId);
  }
  const fillRows = orders.length
    ? await tx
        .select({
          intentId: fills.intentId,
          quantity: fills.quantity,
          price: fills.price,
          fee: fills.fee,
          filledAt: fills.filledAt,
        })
        .from(fills)
        .where(
          inArray(
            fills.intentId,
            orders.map((o) => o.intent.id),
          ),
        )
    : [];

  const instrumentRows = ids.size
    ? await tx
        .select({
          id: instruments.id,
          symbol: instruments.symbol,
          assetClass: instruments.assetClass,
          lotSize: instruments.lotSize,
          shortable: instruments.shortable,
        })
        .from(instruments)
        .where(inArray(instruments.id, [...ids]))
    : [];
  const instrumentMap = new Map(
    instrumentRows.map((r) => [
      r.id,
      {
        symbol: r.symbol,
        assetClass: r.assetClass,
        lotSize: r.lotSize,
        ...(r.shortable !== null ? { shortable: r.shortable } : {}),
      },
    ]),
  );

  const intentById = new Map(orders.map((o) => [o.intent.id, o]));
  const book = { cash: ZERO, positions: new Map<string, Decimal>() };
  const firstFill = new Map<string, number>();
  const cycleCash = new Map<string, Decimal>();
  const cyclePositions = new Map<string, Map<string, Decimal>>();
  const cycleEntries = new Map<string, Map<string, { quantity: Decimal; cost: Decimal }>>();
  for (const f of fillRows) {
    const o = intentById.get(f.intentId);
    if (!o) continue;
    const sign = o.intent.direction === 'buy' ? 1 : -1;
    const q = new Decimal(f.quantity);
    const flow = q.times(f.price).times(-sign).minus(f.fee);
    book.cash = book.cash.plus(flow);
    const id = o.intent.instrumentId;
    book.positions.set(id, (book.positions.get(id) ?? ZERO).plus(q.times(sign)));
    const cid = o.intent.cycleId;
    cycleCash.set(cid, (cycleCash.get(cid) ?? ZERO).plus(flow));
    const cp = cyclePositions.get(cid) ?? new Map<string, Decimal>();
    cp.set(id, (cp.get(id) ?? ZERO).plus(q.times(sign)));
    cyclePositions.set(cid, cp);
    if (o.intent.phase === 'entry') {
      const ce = cycleEntries.get(cid) ?? new Map<string, { quantity: Decimal; cost: Decimal }>();
      const prev = ce.get(id) ?? { quantity: ZERO, cost: ZERO };
      ce.set(id, { quantity: prev.quantity.plus(q), cost: prev.cost.plus(q.times(f.price)) });
      cycleEntries.set(cid, ce);
    }
    const t = f.filledAt.getTime();
    firstFill.set(f.intentId, Math.min(firstFill.get(f.intentId) ?? t, t));
  }

  const cycleRows = await tx
    .select()
    .from(strategyCycles)
    .where(eq(strategyCycles.runtimeId, runtimeId))
    .orderBy(asc(strategyCycles.seq));
  const policy = definition.execution.marketHoursPolicy;
  const cycles: ActiveCycle[] = cycleRows
    .filter((c) => c.status !== 'closed' && c.status !== 'aborted')
    .map((c) => {
      const legs: LegRecord[] = orders
        .filter((o) => o.intent.cycleId === c.id)
        .map((o) => {
          const placedAt = o.intent.eligibleAt.getTime();
          return {
            legId:
              o.intent.phase === 'flatten'
                ? `flatten-${o.intent.instrumentId}`
                : (o.intent.plannedOrderId ?? o.intent.id),
            phase: o.intent.phase as LegRecord['phase'],
            attempt: o.intent.attempt,
            intentId: o.intent.id,
            instrumentId: o.intent.instrumentId,
            direction: o.intent.direction as LegRecord['direction'],
            state: o.state,
            quantity: new Decimal(o.intent.quantity),
            filled: new Decimal(o.filledQuantity),
            placedAt,
            activeFrom: activeFromFor(placedAt, policy) ?? placedAt,
            firstFillAt: firstFill.get(o.intent.id),
            filledAt: o.filledAt?.getTime(),
            cancelRequested: o.cancelRequestedAt !== null,
          };
        });
      return {
        id: c.id,
        seq: c.seq,
        cycle: { ...(c.state as Omit<CycleState, 'status'>), status: c.status },
        legs,
        positions: cyclePositions.get(c.id) ?? new Map(),
        cash: cycleCash.get(c.id) ?? ZERO,
        entries: cycleEntries.get(c.id) ?? new Map(),
        entryTriggerEventId: c.entryTriggerEventId,
        exitTriggerEventId: c.exitTriggerEventId,
      };
    });

  const working: WorkingOrder[] = orders
    .filter((o) => (WORKING_STATES as readonly string[]).includes(o.state))
    .map((o) => ({
      intent: o.intent,
      state: o.state,
      brokerOrderId: o.brokerOrderId,
      cancelRequested: o.cancelRequestedAt !== null,
      symbol: instrumentMap.get(o.intent.instrumentId)?.symbol ?? '?',
    }));

  return {
    id: rt.runtime.id,
    userId: rt.runtime.userId,
    strategyId: rt.runtime.strategyId,
    strategyName: rt.strategyName ?? 'A strategy',
    versionId: rt.runtime.versionId,
    status: rt.runtime.status,
    activeSince: rt.runtime.resumedAt ?? rt.runtime.startedAt,
    state,
    definition,
    instruments: instrumentMap,
    accounts: [...accounts],
    halted: await isHalted(tx, rt.runtime.userId),
    cycles,
    nextSeq: (cycleRows.at(-1)?.seq ?? 0) + 1,
    book,
    working,
  };
}

// ---------------------------------------------------------------------------
// Writing decisions
// ---------------------------------------------------------------------------

export async function saveRuntimeState(
  tx: Transaction,
  runtimeId: string,
  state: RuntimeState,
  evaluatedAt: Date,
) {
  await tx
    .update(strategyRuntimes)
    .set({ state, lastEvaluatedAt: evaluatedAt })
    .where(eq(strategyRuntimes.id, runtimeId));
}

export interface TriggerEventInput {
  /** Chosen by the caller when a cycle must refer to the event before it is written. */
  id?: string | undefined;
  userId: string;
  runtimeId: string;
  cycleId?: string | undefined;
  phase: PhaseName;
  dataTime: Date;
  evaluatedAt: Date;
  result: boolean | undefined;
  qualified: boolean;
  values: Record<string, string | null>;
}

export async function recordTriggerEvent(tx: Transaction, e: TriggerEventInput): Promise<string> {
  const [row] = await tx
    .insert(triggerEvents)
    .values({
      ...(e.id ? { id: e.id } : {}),
      userId: e.userId,
      runtimeId: e.runtimeId,
      cycleId: e.cycleId ?? null,
      phase: e.phase,
      dataTime: e.dataTime,
      evaluatedAt: e.evaluatedAt,
      result: e.result === undefined ? 'unknown' : String(e.result),
      qualified: e.qualified,
      values: e.values,
    })
    .returning({ id: triggerEvents.id });
  if (!row) throw new Error('Failed to record the trigger event');
  return row.id;
}

export async function insertCycle(
  tx: Transaction,
  input: {
    userId: string;
    runtimeId: string;
    seq: number;
    cycle: CycleState;
    entryTriggerEventId?: string | undefined;
    at: Date;
  },
): Promise<string> {
  const { status, ...state } = input.cycle;
  const [row] = await tx
    .insert(strategyCycles)
    .values({
      userId: input.userId,
      runtimeId: input.runtimeId,
      seq: input.seq,
      status,
      state,
      entryTriggerEventId: input.entryTriggerEventId ?? null,
      entryTriggeredAt: input.at,
    })
    .returning({ id: strategyCycles.id });
  if (!row) throw new Error('Failed to create the cycle');
  return row.id;
}

export async function saveCycle(
  tx: Transaction,
  cycleId: string,
  cycle: CycleState,
  extra: {
    entryTriggerEventId?: string;
    exitTriggerEventId?: string;
    realizedPnl?: string;
    closedAt?: Date;
  } = {},
) {
  const { status, ...state } = cycle;
  await tx
    .update(strategyCycles)
    .set({
      status,
      state,
      positionOpenedAt:
        cycle.positionOpenedAt === undefined ? null : new Date(cycle.positionOpenedAt),
      exitTriggeredAt: cycle.exitTriggeredAt === undefined ? null : new Date(cycle.exitTriggeredAt),
      ...(extra.entryTriggerEventId ? { entryTriggerEventId: extra.entryTriggerEventId } : {}),
      ...(extra.exitTriggerEventId ? { exitTriggerEventId: extra.exitTriggerEventId } : {}),
      ...(extra.realizedPnl !== undefined ? { realizedPnl: extra.realizedPnl } : {}),
      ...(isFinished(status) ? { closedAt: extra.closedAt ?? new Date() } : { closedAt: null }),
      rowVersion: sql`${strategyCycles.rowVersion} + 1`,
    })
    .where(eq(strategyCycles.id, cycleId));
}

const isFinished = (s: CycleStatus) => s === 'closed' || s === 'aborted';

export const scheduleKey = (cycleId: string, phase: string, legId: string, attempt: number) =>
  `${cycleId}:${phase}:${legId}:${attempt}`;

/** Records when a leg becomes due (§6.8), keyed so it is stored once per leg. */
export async function scheduleLeg(
  tx: Transaction,
  input: {
    userId: string;
    runtimeId: string;
    cycleId: string;
    phase: PhaseName;
    legId: string;
    attempt: number;
    dueAt: Date;
    referenceKind: string;
    referenceId?: string | undefined;
  },
): Promise<string> {
  const dedupeKey = scheduleKey(input.cycleId, input.phase, input.legId, input.attempt);
  const [row] = await tx
    .insert(scheduledActions)
    .values({
      userId: input.userId,
      runtimeId: input.runtimeId,
      cycleId: input.cycleId,
      kind: 'submit_leg',
      phase: input.phase,
      legId: input.legId,
      dueAt: input.dueAt,
      referenceKind: input.referenceKind,
      referenceId: input.referenceId ?? null,
      dedupeKey,
    })
    .onConflictDoUpdate({
      target: [scheduledActions.userId, scheduledActions.dedupeKey],
      set: { dueAt: input.dueAt },
      setWhere: eq(scheduledActions.status, 'pending'),
    })
    .returning({ id: scheduledActions.id });
  if (row) return row.id;
  const [existing] = await tx
    .select({ id: scheduledActions.id })
    .from(scheduledActions)
    .where(
      and(eq(scheduledActions.userId, input.userId), eq(scheduledActions.dedupeKey, dedupeKey)),
    );
  if (!existing) throw new Error('Failed to schedule the leg');
  return existing.id;
}

export async function finishScheduled(
  tx: Transaction,
  userId: string,
  dedupeKey: string,
  status: 'done' | 'canceled',
) {
  await tx
    .update(scheduledActions)
    .set({ status, doneAt: new Date() })
    .where(
      and(
        eq(scheduledActions.userId, userId),
        eq(scheduledActions.dedupeKey, dedupeKey),
        eq(scheduledActions.status, 'pending'),
      ),
    );
}

/**
 * Marks an order for cancellation (§8.1, §14.3). Returns what the broker needs
 * to cancel it, or undefined if the order never reached a broker (it is then
 * canceled here) or is already finished.
 */
export async function requestCancel(
  tx: Transaction,
  intentId: string,
  source: 'app' | 'user',
  reason: string,
): Promise<{ accountId: string; brokerOrderId: string } | undefined> {
  const [row] = await tx
    .select({
      state: brokerOrders.state,
      userId: brokerOrders.userId,
      brokerOrderId: brokerOrders.brokerOrderId,
      cancelRequestedAt: brokerOrders.cancelRequestedAt,
      accountId: orderIntents.accountId,
    })
    .from(brokerOrders)
    .innerJoin(orderIntents, eq(orderIntents.id, brokerOrders.intentId))
    .where(eq(brokerOrders.intentId, intentId))
    .for('update', { of: brokerOrders });
  if (!row) throw new OrderError('not_found', 'Order not found');
  if (!(WORKING_STATES as readonly string[]).includes(row.state)) return undefined;

  if (row.state === 'ready' && !row.brokerOrderId) {
    const to = transitionOrder('ready', 'canceled');
    await tx
      .update(brokerOrders)
      .set({ state: to, cancelRequestedAt: new Date(), terminalAt: new Date(), reason })
      .where(eq(brokerOrders.intentId, intentId));
    await tx.insert(orderEvents).values({
      userId: row.userId,
      intentId,
      source,
      fromState: 'ready',
      toState: to,
      payload: { kind: 'canceled_before_submit', reason },
    });
    return undefined;
  }
  if (!row.cancelRequestedAt) {
    if (source === 'app') {
      await recordAudit(tx, {
        userId: row.userId,
        actorType: 'system',
        action: 'order.cancel_requested',
        resourceType: 'order_intent',
        resourceId: intentId,
        context: { fromState: row.state, reason: reason.slice(0, 200) },
      });
    }
    await tx
      .update(brokerOrders)
      .set({ cancelRequestedAt: new Date() })
      .where(eq(brokerOrders.intentId, intentId));
    await tx.insert(orderEvents).values({
      userId: row.userId,
      intentId,
      source,
      fromState: row.state,
      toState: row.state,
      payload: { kind: 'cancel_requested', reason },
    });
  }
  return row.brokerOrderId
    ? { accountId: row.accountId, brokerOrderId: row.brokerOrderId }
    : undefined;
}

export async function getSyncCursor(tx: Transaction, accountId: string) {
  const [row] = await tx
    .select({ cursor: brokerSyncs.cursor })
    .from(brokerSyncs)
    .where(eq(brokerSyncs.accountId, accountId));
  return row?.cursor ?? undefined;
}

export async function setSyncCursor(
  tx: Transaction,
  userId: string,
  accountId: string,
  cursor: string | undefined,
) {
  await tx
    .insert(brokerSyncs)
    .values({ accountId, userId, cursor: cursor ?? null })
    .onConflictDoUpdate({
      target: brokerSyncs.accountId,
      set: { cursor: cursor ?? null, syncedAt: new Date() },
    });
}

/** Intents by client order id (the idempotency key), for routing broker updates. */
export async function intentsByClientOrderId(
  tx: Transaction,
  keys: readonly string[],
): Promise<Map<string, string>> {
  if (keys.length === 0) return new Map();
  const rows = await tx
    .select({ id: orderIntents.id, key: orderIntents.idempotencyKey })
    .from(orderIntents)
    .where(inArray(orderIntents.idempotencyKey, [...new Set(keys)]));
  return new Map(rows.map((r) => [r.key, r.id]));
}

/** Pending scheduled legs of a runtime, for the Orders tab's Scheduled view (§8.3). */
export async function pendingSchedule(tx: Transaction, runtimeId: string) {
  return tx
    .select()
    .from(scheduledActions)
    .where(and(eq(scheduledActions.runtimeId, runtimeId), eq(scheduledActions.status, 'pending')))
    .orderBy(asc(scheduledActions.dueAt));
}

/** Runtimes of a strategy, newest first. */
export async function runtimesForStrategy(tx: Transaction, strategyId: string) {
  return tx
    .select()
    .from(strategyRuntimes)
    .where(eq(strategyRuntimes.strategyId, strategyId))
    .orderBy(sql`${strategyRuntimes.startedAt} desc`);
}

/** Serializes paper-broker work per tenant, so two workers never fill one order twice. */
export async function lockPaperBroker(tx: Transaction, userId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`paper:${userId}`}))`);
}

/** When the account was last reconciled (§8.5), or undefined if never. */
export async function getReconciledAt(tx: Transaction, accountId: string) {
  const [row] = await tx
    .select({ at: brokerSyncs.reconciledAt })
    .from(brokerSyncs)
    .where(eq(brokerSyncs.accountId, accountId));
  return row?.at ?? undefined;
}

export async function setReconciledAt(
  tx: Transaction,
  userId: string,
  accountId: string,
  at: Date,
): Promise<void> {
  await tx
    .insert(brokerSyncs)
    .values({ accountId, userId, reconciledAt: at })
    .onConflictDoUpdate({ target: brokerSyncs.accountId, set: { reconciledAt: at } });
}

/** States of the runtime's newest orders created after `since`, newest first. */
export async function recentOrderStates(
  tx: Transaction,
  runtimeId: string,
  since: Date,
  limit: number,
): Promise<OrderState[]> {
  const rows = await tx
    .select({ state: brokerOrders.state })
    .from(orderIntents)
    .innerJoin(brokerOrders, eq(brokerOrders.intentId, orderIntents.id))
    .where(and(eq(orderIntents.runtimeId, runtimeId), gt(orderIntents.createdAt, since)))
    .orderBy(desc(orderIntents.createdAt), desc(orderIntents.id))
    .limit(limit);
  return rows.map((r) => r.state);
}
