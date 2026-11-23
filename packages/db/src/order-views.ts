import {
  checkPreTradeRisk,
  type OrderState,
  type PhaseName,
  type PlannedOrder,
  type StrategyDefinition,
  liveTradingEnabled,
  valuationSession,
} from '@tm/domain';
import Decimal from 'decimal.js';
import { and, asc, count, desc, eq, inArray, or, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { accountFeedChains, fallbackInUse } from './account-feeds';
import { haltText, runtimeAccountHalt } from './account-risk';
import { recordAudit } from './audit';
import { assertCanResume } from './entitlements';
import {
  listOpenIncidents,
  listRecentlyClosedFeedIncidents,
  type ClosedIncidentRow,
  type IncidentRow,
} from './incidents';
import type { Transaction } from './client';
import { idempotencyKey, OrderError, recordOrderIntent } from './orders';
import { LIVE_OFF_TEXT } from './live-gate';
import { runtimeTodayFigures, type RuntimeToday } from './performance-views';
import {
  requestCancel,
  resumeRuntime,
  runtimeMode,
  setKillSwitch,
  WORKING_STATES,
} from './runtime';
import {
  brokerOrders,
  executionControls,
  fills,
  instruments,
  orderEvents,
  orderIntents,
  orderPriceViews,
  scheduledActions,
  strategies,
  strategyCycles,
  strategyRuntimes,
  strategyVersions,
  tradingAccounts,
  triggerEvents,
  watchQuotes,
} from './schema';

/**
 * What the Orders tab reads and the few actions a person can take on orders
 * (Design v1.0 §8.1, §8.3, §14.3, §15.2). Every manual action is recorded with
 * `source: 'user'`, so it stays distinguishable from what strategies did.
 */

export const ORDER_VIEWS = ['all', 'working', 'filled', 'closed', 'scheduled'] as const;
export type OrderView = (typeof ORDER_VIEWS)[number];

const VIEW_STATES: Record<Exclude<OrderView, 'all' | 'scheduled'>, OrderState[]> = {
  working: ['planned', 'scheduled', 'pending_risk', ...WORKING_STATES],
  filled: ['filled'],
  closed: ['canceled', 'rejected', 'expired', 'failed'],
};

export interface OrderFilters {
  view?: OrderView | undefined;
  strategyId?: string | undefined;
  runtimeId?: string | undefined;
  cycleId?: string | undefined;
  phase?: 'entry' | 'exit' | 'flatten' | undefined;
  instrumentId?: string | undefined;
  accountId?: string | undefined;
  /** Calendar dates (YYYY-MM-DD) in `timeZone`, inclusive. */
  from?: string | undefined;
  to?: string | undefined;
  timeZone?: string | undefined;
  limit?: number | undefined;
}

export interface OrderRow {
  id: string;
  mode: 'paper' | 'live';
  source: 'strategy' | 'user' | 'system';
  /** Why a safety close was placed (N306); null for other orders and earlier safety closes. */
  closeReason: string | null;
  strategyId: string;
  strategyName: string;
  /** The strategy's own S number (ADR 0066); null if it has none or was deleted. */
  strategyNumber: string | null;
  runtimeId: string;
  cycleId: string;
  cycleSeq: number;
  phase: 'entry' | 'exit' | 'flatten';
  legLabel: string;
  instrumentId: string;
  symbol: string;
  side: string;
  quantity: string;
  orderType: string;
  limitPrice: string | null;
  stopPrice: string | null;
  timeInForce: string;
  state: OrderState;
  filledQuantity: string;
  averagePrice: string | null;
  /**
   * The instrument's latest price (N330), from the prices the worker keeps
   * while Orders is open (after-hours trade when newer); null when none.
   */
  lastPrice: number | null;
  lastPriceAt: string | null;
  accountId: string;
  accountName: string;
  accountMode: 'paper' | 'live';
  reason: string | null;
  cancelRequested: boolean;
  createdAt: string;
  submittedAt: string | null;
  filledAt: string | null;
  terminalAt: string | null;
}

/** A leg waiting for its timing rule (§6.8); it has no order yet. */
export interface ScheduledRow {
  id: string;
  strategyId: string;
  strategyName: string;
  /** The strategy's own S number (ADR 0066); null if it has none or was deleted. */
  strategyNumber: string | null;
  runtimeId: string;
  cycleId: string;
  cycleSeq: number;
  phase: 'entry' | 'exit' | 'flatten';
  legId: string | null;
  legLabel: string;
  symbol: string | null;
  side: string | null;
  dueAt: string;
}

export type OrderCounts = Record<OrderView, number>;

export interface OrderList {
  orders: OrderRow[];
  scheduled: ScheduledRow[];
  counts: OrderCounts;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function rangeConditions(f: OrderFilters, column: AnyColumn) {
  const zone = f.timeZone ?? 'UTC';
  const out: SQL[] = [];
  if (f.from) out.push(sql`${column} >= (${f.from}::date)::timestamp at time zone ${zone}`);
  if (f.to) {
    out.push(sql`${column} < ((${f.to}::date + 1)::timestamp at time zone ${zone})`);
  }
  return out;
}

function intentConditions(f: OrderFilters): SQL[] {
  const out: SQL[] = [];
  if (f.strategyId) out.push(eq(orderIntents.strategyId, f.strategyId));
  if (f.runtimeId) out.push(eq(orderIntents.runtimeId, f.runtimeId));
  if (f.cycleId) out.push(eq(orderIntents.cycleId, f.cycleId));
  if (f.phase) out.push(eq(orderIntents.phase, f.phase));
  if (f.instrumentId) out.push(eq(orderIntents.instrumentId, f.instrumentId));
  if (f.accountId) out.push(eq(orderIntents.accountId, f.accountId));
  out.push(...rangeConditions(f, orderIntents.createdAt));
  return out;
}

const orderColumns = {
  id: orderIntents.id,
  mode: orderIntents.mode,
  source: orderIntents.source,
  closeReason: orderIntents.closeReason,
  strategyId: orderIntents.strategyId,
  strategyName: strategies.name,
  strategyNumber: strategies.labNumber,
  runtimeId: orderIntents.runtimeId,
  cycleId: orderIntents.cycleId,
  cycleSeq: strategyCycles.seq,
  phase: orderIntents.phase,
  legLabel: orderIntents.legLabel,
  instrumentId: orderIntents.instrumentId,
  symbol: instruments.symbol,
  side: orderIntents.side,
  quantity: orderIntents.quantity,
  orderType: orderIntents.orderType,
  limitPrice: orderIntents.limitPrice,
  stopPrice: orderIntents.stopPrice,
  timeInForce: orderIntents.timeInForce,
  state: brokerOrders.state,
  filledQuantity: brokerOrders.filledQuantity,
  averagePrice: brokerOrders.averagePrice,
  accountId: orderIntents.accountId,
  accountName: tradingAccounts.nickname,
  accountMode: tradingAccounts.mode,
  reason: brokerOrders.reason,
  cancelRequestedAt: brokerOrders.cancelRequestedAt,
  createdAt: orderIntents.createdAt,
  submittedAt: brokerOrders.submittedAt,
  filledAt: brokerOrders.filledAt,
  terminalAt: brokerOrders.terminalAt,
};

type RawOrder = {
  [K in keyof typeof orderColumns]: (typeof orderColumns)[K]['_']['data'] | null;
};

function toOrderRow(r: RawOrder): OrderRow {
  return {
    id: r.id as string,
    mode: r.mode as OrderRow['mode'],
    source: r.source as OrderRow['source'],
    closeReason: r.closeReason ?? null,
    strategyId: r.strategyId as string,
    strategyName: r.strategyName ?? 'Deleted strategy',
    strategyNumber: r.strategyNumber ?? null,
    runtimeId: r.runtimeId as string,
    cycleId: r.cycleId as string,
    cycleSeq: r.cycleSeq ?? 0,
    phase: r.phase as OrderRow['phase'],
    legLabel: r.legLabel as string,
    instrumentId: r.instrumentId as string,
    symbol: r.symbol ?? '?',
    side: r.side as string,
    quantity: r.quantity as string,
    orderType: r.orderType as string,
    limitPrice: r.limitPrice,
    stopPrice: r.stopPrice,
    timeInForce: r.timeInForce as string,
    state: r.state as OrderState,
    filledQuantity: r.filledQuantity ?? '0',
    averagePrice: r.averagePrice,
    lastPrice: null,
    lastPriceAt: null,
    accountId: r.accountId as string,
    accountName: r.accountName ?? 'Unknown account',
    accountMode: r.accountMode ?? 'paper',
    reason: r.reason,
    cancelRequested: r.cancelRequestedAt !== null,
    createdAt: (r.createdAt as Date).toISOString(),
    submittedAt: iso(r.submittedAt),
    filledAt: iso(r.filledAt),
    terminalAt: iso(r.terminalAt),
  };
}

function orderQuery(tx: Transaction) {
  return tx
    .select(orderColumns)
    .from(orderIntents)
    .innerJoin(brokerOrders, eq(brokerOrders.intentId, orderIntents.id))
    .innerJoin(strategyCycles, eq(strategyCycles.id, orderIntents.cycleId))
    .leftJoin(strategies, eq(strategies.id, orderIntents.strategyId))
    .leftJoin(instruments, eq(instruments.id, orderIntents.instrumentId))
    .leftJoin(tradingAccounts, eq(tradingAccounts.id, orderIntents.accountId));
}

function legOf(definition: unknown, phase: string, legId: string | null) {
  const def = definition as StrategyDefinition | null;
  if (!def || !legId || (phase !== 'entry' && phase !== 'exit')) return undefined;
  return def[phase].orders.find((o) => o.id === legId);
}

async function listScheduled(tx: Transaction, f: OrderFilters): Promise<ScheduledRow[]> {
  const where: SQL[] = [
    eq(scheduledActions.status, 'pending'),
    eq(scheduledActions.kind, 'submit_leg'),
  ];
  if (f.strategyId) where.push(eq(strategyRuntimes.strategyId, f.strategyId));
  if (f.runtimeId) where.push(eq(scheduledActions.runtimeId, f.runtimeId));
  if (f.cycleId) where.push(eq(scheduledActions.cycleId, f.cycleId));
  if (f.phase) where.push(eq(scheduledActions.phase, f.phase));
  // Every leg of a run goes to the run's account (N308).
  if (f.accountId) where.push(eq(strategyRuntimes.accountId, f.accountId));
  // The instrument is filtered below, once the leg is known.
  where.push(...rangeConditions(f, scheduledActions.createdAt));
  const rows = await tx
    .select({
      id: scheduledActions.id,
      strategyId: strategyRuntimes.strategyId,
      strategyName: strategies.name,
      strategyNumber: strategies.labNumber,
      runtimeId: scheduledActions.runtimeId,
      cycleId: scheduledActions.cycleId,
      cycleSeq: strategyCycles.seq,
      phase: scheduledActions.phase,
      legId: scheduledActions.legId,
      dueAt: scheduledActions.dueAt,
      definition: strategyVersions.definition,
    })
    .from(scheduledActions)
    .innerJoin(strategyRuntimes, eq(strategyRuntimes.id, scheduledActions.runtimeId))
    .innerJoin(strategyCycles, eq(strategyCycles.id, scheduledActions.cycleId))
    .innerJoin(strategyVersions, eq(strategyVersions.id, strategyRuntimes.versionId))
    .leftJoin(strategies, eq(strategies.id, strategyRuntimes.strategyId))
    .where(and(...where))
    .orderBy(asc(scheduledActions.dueAt))
    .limit(f.limit ?? 200);

  const legs = rows.map((r) => legOf(r.definition, r.phase, r.legId));
  const ids = [...new Set(legs.flatMap((l) => (l ? [l.instrumentId] : [])))];
  const symbols = new Map(
    ids.length === 0
      ? []
      : (
          await tx
            .select({ id: instruments.id, symbol: instruments.symbol })
            .from(instruments)
            .where(inArray(instruments.id, ids))
        ).map((i) => [i.id, i.symbol]),
  );
  return rows.flatMap((r, i) => {
    const leg = legs[i];
    if (f.instrumentId && leg?.instrumentId !== f.instrumentId) return [];
    return [
      {
        id: r.id,
        strategyId: r.strategyId,
        strategyName: r.strategyName ?? 'Deleted strategy',
        strategyNumber: r.strategyNumber ?? null,
        runtimeId: r.runtimeId,
        cycleId: r.cycleId,
        cycleSeq: r.cycleSeq,
        phase: r.phase as ScheduledRow['phase'],
        legId: r.legId,
        legLabel: leg?.legLabel ?? r.legId ?? 'Leg',
        symbol: leg ? (symbols.get(leg.instrumentId) ?? null) : null,
        side: leg?.side ?? null,
        dueAt: r.dueAt.toISOString(),
      },
    ];
  });
}

/** Orders newest first, the legs still waiting on timing, and counts per view (§8.3, §15.2). */
/** Adds each order's instrument's latest stored price (N330). */
async function withLastPrices(tx: Transaction, rows: OrderRow[]): Promise<OrderRow[]> {
  if (rows.length === 0) return rows;
  const quotes = await tx
    .select({
      symbol: watchQuotes.symbol,
      last: watchQuotes.last,
      priceAt: watchQuotes.priceAt,
      extLast: watchQuotes.extLast,
      extAt: watchQuotes.extAt,
    })
    .from(watchQuotes)
    .where(inArray(watchQuotes.symbol, [...new Set(rows.map((r) => r.symbol))]));
  const bySymbol = new Map(
    quotes.map((q) => {
      const ext = q.extLast !== null && q.extAt !== null && q.extAt > q.priceAt;
      return [
        q.symbol,
        ext
          ? { price: q.extLast as number, at: (q.extAt as Date).toISOString() }
          : { price: q.last, at: q.priceAt.toISOString() },
      ];
    }),
  );
  return rows.map((r) => {
    const q = bySymbol.get(r.symbol);
    return q ? { ...r, lastPrice: q.price, lastPriceAt: q.at } : r;
  });
}

/**
 * Marks Orders as open now (N330), at most every 10 seconds: while it is,
 * the worker also prices the instruments of this person's orders.
 */
export async function touchOrderPriceView(tx: Transaction, userId: string): Promise<void> {
  await tx
    .insert(orderPriceViews)
    .values({ userId })
    .onConflictDoUpdate({
      target: orderPriceViews.userId,
      set: { viewedAt: sql`now()` },
      setWhere: sql`${orderPriceViews.viewedAt} < now() - interval '10 seconds'`,
    });
}

export async function listOrders(tx: Transaction, f: OrderFilters = {}): Promise<OrderList> {
  const base = intentConditions(f);
  const view = f.view ?? 'all';

  const scheduled = await listScheduled(tx, f);
  const grouped = await tx
    .select({ state: brokerOrders.state, n: count() })
    .from(orderIntents)
    .innerJoin(brokerOrders, eq(brokerOrders.intentId, orderIntents.id))
    .where(and(...base))
    .groupBy(brokerOrders.state);
  const counts: OrderCounts = { all: 0, working: 0, filled: 0, closed: 0, scheduled: 0 };
  for (const g of grouped) {
    counts.all += g.n;
    for (const v of ['working', 'filled', 'closed'] as const) {
      if (VIEW_STATES[v].includes(g.state)) counts[v] += g.n;
    }
  }
  counts.scheduled = scheduled.length;

  let orders: OrderRow[] = [];
  if (view !== 'scheduled') {
    const where = [...base];
    if (view !== 'all') where.push(inArray(brokerOrders.state, VIEW_STATES[view]));
    const rows = await orderQuery(tx)
      .where(and(...where))
      .orderBy(desc(orderIntents.createdAt), desc(orderIntents.id))
      .limit(f.limit ?? 200);
    orders = await withLastPrices(tx, rows.map(toOrderRow));
  }
  return { orders, scheduled: view === 'all' || view === 'scheduled' ? scheduled : [], counts };
}

export interface OrderTimelineItem {
  seq: number;
  source: string;
  fromState: OrderState | null;
  toState: OrderState | null;
  kind: string;
  detail: Record<string, unknown>;
  providerAt: string | null;
  receivedAt: string;
}

export interface OrderDetail extends OrderRow {
  versionId: string;
  versionNo: number | null;
  attempt: number;
  idempotencyKey: string;
  brokerOrderId: string | null;
  rawStatus: string | null;
  eligibleAt: string;
  referencePrice: string;
  extendedHours: boolean;
  fees: string;
  risk: unknown;
  /** The planned order and phase rule the order came from (§8.3 "source rule"). */
  sourceRule: {
    plannedOrder: PlannedOrder | null;
    condition: StrategyDefinition['entry']['condition'] | null;
    trigger: StrategyDefinition['entry']['trigger'] | null;
  };
  triggerEvent: {
    id: string;
    result: string;
    qualified: boolean;
    dataTime: string;
    evaluatedAt: string;
    values: unknown;
  } | null;
  fills: { id: string; quantity: string; price: string; fee: string; filledAt: string }[];
  timeline: OrderTimelineItem[];
}

export async function getOrderDetail(tx: Transaction, intentId: string): Promise<OrderDetail> {
  const [row] = await orderQuery(tx).where(eq(orderIntents.id, intentId));
  if (!row) throw new OrderError('not_found', 'Order not found');
  const [extra] = await tx
    .select({
      versionId: orderIntents.versionId,
      versionNo: strategyVersions.versionNo,
      definition: strategyVersions.definition,
      attempt: orderIntents.attempt,
      idempotencyKey: orderIntents.idempotencyKey,
      plannedOrderId: orderIntents.plannedOrderId,
      triggerEventId: orderIntents.triggerEventId,
      brokerOrderId: brokerOrders.brokerOrderId,
      rawStatus: brokerOrders.rawStatus,
      eligibleAt: orderIntents.eligibleAt,
      referencePrice: orderIntents.referencePrice,
      extendedHours: orderIntents.extendedHours,
      fees: brokerOrders.fees,
      risk: orderIntents.risk,
    })
    .from(orderIntents)
    .innerJoin(brokerOrders, eq(brokerOrders.intentId, orderIntents.id))
    .leftJoin(strategyVersions, eq(strategyVersions.id, orderIntents.versionId))
    .where(eq(orderIntents.id, intentId));
  if (!extra) throw new OrderError('not_found', 'Order not found');

  const [trigger] = extra.triggerEventId
    ? await tx.select().from(triggerEvents).where(eq(triggerEvents.id, extra.triggerEventId))
    : [];
  const fillRows = await tx
    .select()
    .from(fills)
    .where(eq(fills.intentId, intentId))
    .orderBy(asc(fills.filledAt), asc(fills.id));
  const events = await tx
    .select()
    .from(orderEvents)
    .where(eq(orderEvents.intentId, intentId))
    .orderBy(asc(orderEvents.seq));

  const order = toOrderRow(row);
  const def = extra.definition as StrategyDefinition | null;
  const phaseRule = def && order.phase !== 'flatten' ? def[order.phase] : null;
  return {
    ...order,
    versionId: extra.versionId,
    versionNo: extra.versionNo,
    attempt: extra.attempt,
    idempotencyKey: extra.idempotencyKey,
    brokerOrderId: extra.brokerOrderId,
    rawStatus: extra.rawStatus,
    eligibleAt: extra.eligibleAt.toISOString(),
    referencePrice: extra.referencePrice,
    extendedHours: extra.extendedHours,
    fees: extra.fees,
    risk: extra.risk,
    sourceRule: {
      plannedOrder: legOf(def, order.phase, extra.plannedOrderId) ?? null,
      condition: phaseRule?.condition ?? null,
      trigger: phaseRule?.trigger ?? null,
    },
    triggerEvent: trigger
      ? {
          id: trigger.id,
          result: trigger.result,
          qualified: trigger.qualified,
          dataTime: trigger.dataTime.toISOString(),
          evaluatedAt: trigger.evaluatedAt.toISOString(),
          values: trigger.values,
        }
      : null,
    fills: fillRows.map((f) => ({
      id: f.id,
      quantity: f.quantity,
      price: f.price,
      fee: f.fee,
      filledAt: f.filledAt.toISOString(),
    })),
    timeline: events.map((e) => {
      const { kind, ...detail } = (e.payload ?? {}) as { kind?: string } & Record<string, unknown>;
      return {
        seq: e.seq,
        source: e.source,
        fromState: e.fromState,
        toState: e.toState,
        kind: kind ?? 'update',
        detail,
        providerAt: iso(e.providerAt),
        receivedAt: e.receivedAt.toISOString(),
      };
    }),
  };
}

/** A person's cancel (§14.3): recorded as theirs, sent by the runtime's next pass. */
export async function cancelOrderByUser(
  tx: Transaction,
  userId: string,
  intentId: string,
): Promise<OrderDetail> {
  const [row] = await tx
    .select({ state: brokerOrders.state })
    .from(brokerOrders)
    .where(eq(brokerOrders.intentId, intentId));
  if (!row) throw new OrderError('not_found', 'Order not found');
  if (!(WORKING_STATES as readonly string[]).includes(row.state)) {
    throw new OrderError(
      'invalid_state',
      'This order is no longer working, so it cannot be canceled',
    );
  }
  await requestCancel(tx, intentId, 'user', 'Canceled by you');
  await recordAudit(tx, {
    userId,
    actorType: 'user',
    action: 'order.cancel_requested',
    resourceType: 'order_intent',
    resourceId: intentId,
    context: { fromState: row.state },
  });
  return getOrderDetail(tx, intentId);
}

/** Requests a cancel for every working order of one runtime, or of all of them. */
export async function cancelWorkingOrders(
  tx: Transaction,
  userId: string,
  options: { runtimeId?: string; reason: string },
): Promise<number> {
  const where: SQL[] = [inArray(brokerOrders.state, [...WORKING_STATES])];
  if (options.runtimeId) where.push(eq(orderIntents.runtimeId, options.runtimeId));
  const rows = await tx
    .select({ id: orderIntents.id })
    .from(orderIntents)
    .innerJoin(brokerOrders, eq(brokerOrders.intentId, orderIntents.id))
    .where(and(...where));
  for (const r of rows) await requestCancel(tx, r.id, 'user', options.reason);
  if (rows.length > 0) {
    await recordAudit(tx, {
      userId,
      actorType: 'user',
      action: 'order.cancel_all_requested',
      resourceType: options.runtimeId ? 'strategy_runtime' : 'execution_control',
      resourceId: options.runtimeId ?? userId,
      context: { orders: rows.length },
    });
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

export interface PositionRow {
  runtimeId: string;
  runtimeStatus: 'running' | 'paused' | 'stopped';
  strategyId: string;
  strategyName: string;
  /** The strategy's own S number (ADR 0066); null if it has none or was deleted. */
  strategyNumber: string | null;
  instrumentId: string;
  symbol: string;
  accountId: string;
  accountName: string;
  accountMode: 'paper' | 'live';
  /** Positive long, negative short. */
  quantity: string;
  averageCost: string | null;
  lastFillPrice: string;
  lastFillAt: string;
  /** A manual close order for it is still working. */
  closing: boolean;
}

interface Holding {
  qty: Decimal;
  cost: Decimal;
  lastPrice: Decimal;
  lastAt: Date;
  accountId: string;
}

/** Applies one fill to a running average-cost position. */
function applyFill(h: Holding, signed: Decimal, price: Decimal) {
  const next = h.qty.plus(signed);
  if (h.qty.isZero() || h.qty.isNegative() === signed.isNegative()) {
    h.cost = h.cost.plus(signed.abs().times(price));
  } else if (next.isZero() || next.isNegative() !== h.qty.isNegative()) {
    h.cost = next.abs().times(price);
  } else {
    h.cost = h.cost.times(next.abs()).dividedBy(h.qty.abs());
  }
  h.qty = next;
}

async function holdings(tx: Transaction, where: SQL[]) {
  const rows = await tx
    .select({
      runtimeId: orderIntents.runtimeId,
      cycleId: orderIntents.cycleId,
      instrumentId: orderIntents.instrumentId,
      accountId: orderIntents.accountId,
      direction: orderIntents.direction,
      quantity: fills.quantity,
      price: fills.price,
      filledAt: fills.filledAt,
    })
    .from(fills)
    .innerJoin(orderIntents, eq(orderIntents.id, fills.intentId))
    .where(and(...where))
    .orderBy(asc(fills.filledAt), asc(fills.receivedAt), asc(fills.id));
  const byKey = new Map<
    string,
    Holding & { runtimeId: string; cycleId: string; instrumentId: string }
  >();
  for (const r of rows) {
    const key = `${r.cycleId}:${r.instrumentId}`;
    let h = byKey.get(key);
    if (!h) {
      h = {
        runtimeId: r.runtimeId,
        cycleId: r.cycleId,
        instrumentId: r.instrumentId,
        accountId: r.accountId,
        qty: new Decimal(0),
        cost: new Decimal(0),
        lastPrice: new Decimal(r.price),
        lastAt: r.filledAt,
      };
      byKey.set(key, h);
    }
    const q = new Decimal(r.quantity);
    applyFill(h, r.direction === 'buy' ? q : q.negated(), new Decimal(r.price));
    h.lastPrice = new Decimal(r.price);
    h.lastAt = r.filledAt;
  }
  return [...byKey.values()].filter((h) => !h.qty.isZero());
}

/** Net holdings per instrument on one account, across every run, from the app's fills. */
export async function accountPositions(
  tx: Transaction,
  accountId: string,
): Promise<Map<string, Decimal>> {
  const held = await holdings(tx, [eq(orderIntents.accountId, accountId)]);
  const out = new Map<string, Decimal>();
  for (const h of held)
    out.set(h.instrumentId, (out.get(h.instrumentId) ?? new Decimal(0)).plus(h.qty));
  for (const [id, q] of out) if (q.isZero()) out.delete(id);
  return out;
}

async function workingCloses(tx: Transaction, runtimeIds: string[]) {
  if (runtimeIds.length === 0) return new Set<string>();
  const rows = await tx
    .select({ runtimeId: orderIntents.runtimeId, instrumentId: orderIntents.instrumentId })
    .from(orderIntents)
    .innerJoin(brokerOrders, eq(brokerOrders.intentId, orderIntents.id))
    .where(
      and(
        inArray(orderIntents.runtimeId, runtimeIds),
        eq(orderIntents.phase, 'flatten'),
        eq(orderIntents.source, 'user'),
        inArray(brokerOrders.state, [...WORKING_STATES]),
      ),
    );
  return new Set(rows.map((r) => `${r.runtimeId}:${r.instrumentId}`));
}

/** Open positions per strategy runtime and instrument, from the app's own fills (§14.3). */
export async function listPositions(
  tx: Transaction,
  options: { runtimeId?: string } = {},
): Promise<PositionRow[]> {
  const held = await holdings(
    tx,
    options.runtimeId ? [eq(orderIntents.runtimeId, options.runtimeId)] : [],
  );
  // Several cycles of one runtime can each hold part of a position.
  const merged = new Map<string, Holding & { runtimeId: string; instrumentId: string }>();
  for (const h of held) {
    const key = `${h.runtimeId}:${h.instrumentId}`;
    const m = merged.get(key);
    if (!m) {
      merged.set(key, { ...h });
      continue;
    }
    m.qty = m.qty.plus(h.qty);
    m.cost = m.cost.plus(h.cost);
    if (h.lastAt > m.lastAt) {
      m.lastAt = h.lastAt;
      m.lastPrice = h.lastPrice;
    }
  }
  const positions = [...merged.values()].filter((h) => !h.qty.isZero());
  const runtimeIds = [...new Set(positions.map((p) => p.runtimeId))];
  if (runtimeIds.length === 0) return [];
  const runtimes = await tx
    .select({
      id: strategyRuntimes.id,
      status: strategyRuntimes.status,
      strategyId: strategyRuntimes.strategyId,
      strategyName: strategies.name,
      strategyNumber: strategies.labNumber,
    })
    .from(strategyRuntimes)
    .leftJoin(strategies, eq(strategies.id, strategyRuntimes.strategyId))
    .where(inArray(strategyRuntimes.id, runtimeIds));
  const byRuntime = new Map(runtimes.map((r) => [r.id, r]));
  const instrumentIds = [...new Set(positions.map((p) => p.instrumentId))];
  const symbols = new Map(
    (
      await tx
        .select({ id: instruments.id, symbol: instruments.symbol })
        .from(instruments)
        .where(inArray(instruments.id, instrumentIds))
    ).map((i) => [i.id, i.symbol]),
  );
  const accountIds = [...new Set(positions.map((p) => p.accountId))];
  const accounts = new Map(
    (
      await tx
        .select({
          id: tradingAccounts.id,
          name: tradingAccounts.nickname,
          mode: tradingAccounts.mode,
        })
        .from(tradingAccounts)
        .where(inArray(tradingAccounts.id, accountIds))
    ).map((a) => [a.id, a]),
  );
  const closing = await workingCloses(tx, runtimeIds);
  return positions
    .map((p) => {
      const runtime = byRuntime.get(p.runtimeId);
      return {
        runtimeId: p.runtimeId,
        runtimeStatus: runtime?.status ?? 'stopped',
        strategyId: runtime?.strategyId ?? '',
        strategyName: runtime?.strategyName ?? 'Deleted strategy',
        strategyNumber: runtime?.strategyNumber ?? null,
        instrumentId: p.instrumentId,
        symbol: symbols.get(p.instrumentId) ?? '?',
        accountId: p.accountId,
        accountName: accounts.get(p.accountId)?.name ?? 'Unknown account',
        accountMode: accounts.get(p.accountId)?.mode ?? 'paper',
        quantity: p.qty.toString(),
        averageCost: p.cost.dividedBy(p.qty.abs()).toDecimalPlaces(4).toString(),
        lastFillPrice: p.lastPrice.toString(),
        lastFillAt: p.lastAt.toISOString(),
        closing: closing.has(`${p.runtimeId}:${p.instrumentId}`),
      };
    })
    .sort(
      (a, b) => a.strategyName.localeCompare(b.strategyName) || a.symbol.localeCompare(b.symbol),
    );
}

/**
 * Market orders that close what a stopped strategy still holds (§8.1, §14.3).
 * They are the person's orders, not the strategy's: `source: 'user'`, and the
 * runtime submits them on its next pass, like any other ready order.
 */
export async function closePositions(
  tx: Transaction,
  userId: string,
  input: { runtimeId: string; instrumentId?: string | undefined },
): Promise<{ orders: number }> {
  const [runtime] = await tx
    .select({
      id: strategyRuntimes.id,
      status: strategyRuntimes.status,
      strategyId: strategyRuntimes.strategyId,
      versionId: strategyRuntimes.versionId,
    })
    .from(strategyRuntimes)
    .where(eq(strategyRuntimes.id, input.runtimeId))
    .for('update');
  if (!runtime) throw new OrderError('not_found', 'Strategy run not found');
  if (runtime.status !== 'stopped') {
    throw new OrderError(
      'invalid_state',
      'Stop the strategy first; while it runs, its Exit rules manage its positions',
    );
  }
  const where: SQL[] = [eq(orderIntents.runtimeId, runtime.id)];
  if (input.instrumentId) where.push(eq(orderIntents.instrumentId, input.instrumentId));
  const held = await holdings(tx, where);
  if (held.length === 0)
    throw new OrderError('invalid_state', 'There is no open position to close');
  const busy = await workingCloses(tx, [runtime.id]);
  if (held.some((h) => busy.has(`${runtime.id}:${h.instrumentId}`))) {
    throw new OrderError('invalid_state', 'A close order for this position is still working');
  }

  const symbols = new Map(
    (
      await tx
        .select({ id: instruments.id, symbol: instruments.symbol })
        .from(instruments)
        .where(inArray(instruments.id, [...new Set(held.map((h) => h.instrumentId))]))
    ).map((i) => [i.id, i.symbol]),
  );
  let placed = 0;
  for (const h of held) {
    const legId = `close-${h.instrumentId}`;
    const [{ n }] = (await tx
      .select({ n: count() })
      .from(orderIntents)
      .where(
        and(
          eq(orderIntents.cycleId, h.cycleId),
          eq(orderIntents.plannedOrderId, legId),
          eq(orderIntents.source, 'user'),
        ),
      )) as [{ n: number }];
    const attempt = n + 1;
    const long = h.qty.isPositive();
    const quantity = h.qty.abs();
    const risk = checkPreTradeRisk({
      risk: {},
      closing: true,
      quantity,
      referencePrice: h.lastPrice,
      activeOrders: 0,
      grossExposure: new Decimal(0),
      equity: new Decimal(0),
      dailyLossHit: false,
      drawdownHit: false,
      openPositions: 0,
      instrumentHeld: true,
    });
    const recorded = await recordOrderIntent(tx, userId, {
      runtimeId: runtime.id,
      strategyId: runtime.strategyId,
      versionId: runtime.versionId,
      cycleId: h.cycleId,
      phase: 'flatten' as PhaseName,
      plannedOrderId: legId,
      attempt,
      legLabel: `Close ${symbols.get(h.instrumentId) ?? 'position'}`,
      triggerEventId: undefined,
      scheduledActionId: undefined,
      eligibleAt: new Date().toISOString(),
      accountId: h.accountId,
      instrumentId: h.instrumentId,
      side: long ? 'sell' : 'buy_to_cover',
      direction: long ? 'sell' : 'buy',
      quantity: quantity.toString(),
      orderType: 'market',
      limitPrice: undefined,
      stopPrice: undefined,
      timeInForce: 'day',
      extendedHours: false,
      referencePrice: h.lastPrice.toString(),
      risk,
      idempotencyKey: idempotencyKey({
        runtimeId: runtime.id,
        cycleId: h.cycleId,
        phase: 'flatten',
        legId,
        attempt,
      }),
      source: 'user',
    });
    if (recorded.created) placed += 1;
  }
  await recordAudit(tx, {
    userId,
    actorType: 'user',
    action: 'order.manual_close_requested',
    resourceType: 'strategy_runtime',
    resourceId: runtime.id,
    context: { orders: placed, instrumentId: input.instrumentId ?? null },
  });
  return { orders: placed };
}

// ---------------------------------------------------------------------------
// Execution status: kill switch and runtimes, for the Orders header and banner
// ---------------------------------------------------------------------------

export interface RuntimeSummary {
  id: string;
  strategyId: string;
  strategyName: string;
  /** The strategy's own S number (ADR 0066); null if it has none or was deleted. */
  strategyNumber: string | null;
  status: 'running' | 'paused' | 'stopped';
  pauseReason: string | null;
  /** The account the run trades on (N308), with its label and PAPER or LIVE. */
  accountId: string | null;
  accountName: string;
  accountMode: 'paper' | 'live';
  /** The fallback feed its account prices from now (ADR 0108); null on its primary or routes. */
  fallbackFeed: string | null;
  startedAt: string;
  stoppedAt: string | null;
  workingOrders: number;
  /** This run's cycles by outcome (N280). */
  cycles: CycleCounts;
  /** Cycles that completed (Exit closed them) in today's session (N326). */
  completedToday: number;
  /** Cycles rejected (ended with nothing filled) in today's session (N329). */
  rejectedToday: number;
  /** Today's return (N327): realized plus unrealized over today's session. */
  today: RuntimeToday;
  /** Realized profit or loss of this run's completed cycles, in dollars (N304). */
  realizedPnl: string;
  /** Completed cycles that closed with a gain (N304). */
  wins: number;
  /** When this run's latest cycle's Entry fired; null before its first (N304). */
  lastEntryAt: string | null;
}

/**
 * A run's cycles by outcome (N280): completed = Exit closed the position; active = Entry
 * filled and the position is still open or exiting; rejected = ended with nothing filled
 * (a refused, rejected, canceled or expired Entry); entering = Entry orders still working.
 */
export interface CycleCounts {
  completed: number;
  active: number;
  rejected: number;
  entering: number;
}

export interface ExecutionStatus {
  /** The NYSE session "today" means (N326): the one under way, or the last before the open. */
  todaySession: string;
  halted: { at: string; reason: string | null } | null;
  runtimes: RuntimeSummary[];
  /** Open incidents (§8.5): reconciliation mismatches, rejects, data and broker problems. */
  incidents: IncidentRow[];
  /** Price incidents that closed themselves lately, with how long they lasted (N328). */
  recentlyClosed: ClosedIncidentRow[];
}

/** The kill switch, and every runtime that is active or still has working orders. */
export async function getExecutionStatus(
  tx: Transaction,
  today: string = valuationSession(new Date()).date,
): Promise<ExecutionStatus> {
  const [control] = await tx.select().from(executionControls);
  const working = tx
    .select({ runtimeId: orderIntents.runtimeId, n: count().as('n') })
    .from(orderIntents)
    .innerJoin(brokerOrders, eq(brokerOrders.intentId, orderIntents.id))
    .where(inArray(brokerOrders.state, [...WORKING_STATES]))
    .groupBy(orderIntents.runtimeId)
    .as('working');
  const byStatus = (st: string) =>
    sql<number>`count(*) filter (where ${strategyCycles.status} = ${st})`.mapWith(Number);
  const cycleCounts = tx
    .select({
      runtimeId: strategyCycles.runtimeId,
      completed: byStatus('closed').as('completed'),
      active:
        sql<number>`count(*) filter (where ${strategyCycles.status} in ('open', 'exit_working'))`
          .mapWith(Number)
          .as('active'),
      rejected: byStatus('aborted').as('rejected'),
      completedToday:
        sql<number>`count(*) filter (where ${strategyCycles.status} = 'closed' and ${closedOn(today)})`
          .mapWith(Number)
          .as('completed_today'),
      rejectedToday:
        sql<number>`count(*) filter (where ${strategyCycles.status} = 'aborted' and ${closedOn(today)})`
          .mapWith(Number)
          .as('rejected_today'),
      entering: byStatus('entry_working').as('entering'),
      realizedPnl:
        sql<string>`coalesce(sum(${strategyCycles.realizedPnl}) filter (where ${strategyCycles.status} = 'closed'), 0)::text`.as(
          'realized_pnl',
        ),
      wins: sql<number>`count(*) filter (where ${strategyCycles.status} = 'closed' and ${strategyCycles.realizedPnl} > 0)`
        .mapWith(Number)
        .as('wins'),
      lastEntryAt: sql<Date | null>`max(${strategyCycles.entryTriggeredAt})`.as('last_entry_at'),
    })
    .from(strategyCycles)
    .groupBy(strategyCycles.runtimeId)
    .as('cycle_counts');
  const rows = await tx
    .select({
      id: strategyRuntimes.id,
      strategyId: strategyRuntimes.strategyId,
      strategyName: strategies.name,
      strategyNumber: strategies.labNumber,
      status: strategyRuntimes.status,
      pauseReason: strategyRuntimes.pauseReason,
      accountId: strategyRuntimes.accountId,
      accountName: tradingAccounts.nickname,
      accountMode: tradingAccounts.mode,
      startedAt: strategyRuntimes.startedAt,
      stoppedAt: strategyRuntimes.stoppedAt,
      workingOrders: working.n,
      completed: cycleCounts.completed,
      active: cycleCounts.active,
      rejected: cycleCounts.rejected,
      entering: cycleCounts.entering,
      completedToday: cycleCounts.completedToday,
      rejectedToday: cycleCounts.rejectedToday,
      realizedPnl: cycleCounts.realizedPnl,
      wins: cycleCounts.wins,
      lastEntryAt: cycleCounts.lastEntryAt,
    })
    .from(strategyRuntimes)
    .leftJoin(strategies, eq(strategies.id, strategyRuntimes.strategyId))
    .leftJoin(tradingAccounts, eq(tradingAccounts.id, strategyRuntimes.accountId))
    .leftJoin(working, eq(working.runtimeId, strategyRuntimes.id))
    .leftJoin(cycleCounts, eq(cycleCounts.runtimeId, strategyRuntimes.id))
    .where(sql`${strategyRuntimes.status} <> 'stopped' or ${working.n} > 0`)
    .orderBy(desc(strategyRuntimes.startedAt));
  const [incidents, chains, recentlyClosed] = await Promise.all([
    listOpenIncidents(tx),
    accountFeedChains(tx),
    listRecentlyClosedFeedIncidents(tx),
  ]);
  const todays = await runtimeTodayFigures(
    tx,
    rows.map((r) => r.id),
    today,
  );
  return {
    todaySession: today,
    incidents,
    recentlyClosed,
    halted: control?.haltedAt
      ? { at: control.haltedAt.toISOString(), reason: control.reason }
      : null,
    runtimes: rows.map((r) => ({
      id: r.id,
      strategyId: r.strategyId,
      strategyName: r.strategyName ?? 'Deleted strategy',
      strategyNumber: r.strategyNumber ?? null,
      status: r.status,
      pauseReason: r.pauseReason,
      accountId: r.accountId,
      accountName: r.accountName ?? 'Unknown account',
      accountMode: r.accountMode ?? 'paper',
      fallbackFeed: r.accountId ? (fallbackInUse(chains.get(r.accountId))?.name ?? null) : null,
      startedAt: r.startedAt.toISOString(),
      stoppedAt: iso(r.stoppedAt),
      workingOrders: Number(r.workingOrders ?? 0),
      cycles: {
        completed: Number(r.completed ?? 0),
        active: Number(r.active ?? 0),
        rejected: Number(r.rejected ?? 0),
        entering: Number(r.entering ?? 0),
      },
      completedToday: Number(r.completedToday ?? 0),
      rejectedToday: Number(r.rejectedToday ?? 0),
      today: todays.get(r.id) ?? NO_TODAY,
      realizedPnl: r.realizedPnl ?? '0',
      wins: Number(r.wins ?? 0),
      // A raw aggregate comes back as text, not a Date.
      lastEntryAt: r.lastEntryAt ? new Date(r.lastEntryAt).toISOString() : null,
    })),
  };
}

/**
 * What a figure on Strategies on paper counts (N305): the run's working orders, or its cycles
 * by outcome. `completed` also stands behind Realized P/L and Win rate.
 */
export const RUN_DETAIL_KINDS = [
  'working',
  'completed',
  'active',
  'rejected',
  'entering',
  'completed_today',
  'rejected_today',
  'today',
] as const;
export type RunDetailKind = (typeof RUN_DETAIL_KINDS)[number];

/** A cycle closed in the NYSE session `day` (New York date). */
const closedOn = (day: string) =>
  sql`to_char(${strategyCycles.closedAt} at time zone 'America/New_York', 'YYYY-MM-DD') = ${day}`;

const NO_TODAY: RuntimeToday = { pnl: '0.00', realized: '0.00', unrealized: '0.00', pct: null };

const DETAIL_CYCLE_STATUSES: Record<
  Exclude<RunDetailKind, 'working' | 'completed_today' | 'rejected_today' | 'today'>,
  string[]
> = {
  completed: ['closed'],
  active: ['open', 'exit_working'],
  rejected: ['aborted'],
  entering: ['entry_working'],
};

/** At most this many cycles, newest first, are listed in one detail view. */
export const RUN_DETAIL_CYCLE_LIMIT = 300;

export interface RunDetailCycle {
  id: string;
  seq: number;
  status: string;
  entryTriggeredAt: string;
  positionOpenedAt: string | null;
  closedAt: string | null;
  realizedPnl: string | null;
  note: string | null;
}

export interface RunDetail {
  runtimeId: string;
  kind: RunDetailKind;
  /** Every cycle the figure counts, before the limit. */
  totalCycles: number;
  /** Newest first, at most RUN_DETAIL_CYCLE_LIMIT. */
  cycles: RunDetailCycle[];
  /** The orders of those cycles (for `working`, only the working ones), newest first. */
  orders: OrderRow[];
}

/**
 * The cycles and orders behind one figure of a run (N305): double-clicking a number on
 * Strategies on paper lists what it counts.
 */
export async function getRunDetail(
  tx: Transaction,
  runtimeId: string,
  kind: RunDetailKind,
  today: string = valuationSession(new Date()).date,
): Promise<RunDetail> {
  const [run] = await tx
    .select({ id: strategyRuntimes.id })
    .from(strategyRuntimes)
    .where(eq(strategyRuntimes.id, runtimeId));
  if (!run) throw new OrderError('not_found', 'Strategy run not found');

  const byKind = (): SQL | undefined => {
    if (kind === 'completed_today')
      return and(eq(strategyCycles.status, 'closed'), closedOn(today));
    if (kind === 'rejected_today')
      return and(eq(strategyCycles.status, 'aborted'), closedOn(today));
    // Today's return: cycles closed today, and those still holding a position.
    if (kind === 'today')
      return or(
        and(eq(strategyCycles.status, 'closed'), closedOn(today)),
        inArray(strategyCycles.status, ['open', 'exit_working']),
      );
    return inArray(strategyCycles.status, DETAIL_CYCLE_STATUSES[kind as 'completed'] as never[]);
  };
  const cycleWhere =
    kind === 'working'
      ? and(
          eq(strategyCycles.runtimeId, runtimeId),
          sql`exists (select 1 from ${orderIntents} join ${brokerOrders} on ${brokerOrders.intentId} = ${orderIntents.id}
            where ${orderIntents.cycleId} = ${strategyCycles.id} and ${inArray(brokerOrders.state, [...WORKING_STATES])})`,
        )
      : and(eq(strategyCycles.runtimeId, runtimeId), byKind());
  const [{ n }] = (await tx.select({ n: count() }).from(strategyCycles).where(cycleWhere)) as [
    { n: number },
  ];
  const rows = await tx
    .select({
      id: strategyCycles.id,
      seq: strategyCycles.seq,
      status: strategyCycles.status,
      entryTriggeredAt: strategyCycles.entryTriggeredAt,
      positionOpenedAt: strategyCycles.positionOpenedAt,
      closedAt: strategyCycles.closedAt,
      realizedPnl: strategyCycles.realizedPnl,
      note: strategyCycles.note,
    })
    .from(strategyCycles)
    .where(cycleWhere)
    .orderBy(desc(strategyCycles.seq))
    .limit(RUN_DETAIL_CYCLE_LIMIT);
  const cycles: RunDetailCycle[] = rows.map((c) => ({
    id: c.id,
    seq: c.seq,
    status: c.status,
    entryTriggeredAt: c.entryTriggeredAt.toISOString(),
    positionOpenedAt: iso(c.positionOpenedAt),
    closedAt: iso(c.closedAt),
    realizedPnl: c.realizedPnl,
    note: c.note,
  }));

  let orders: OrderRow[] = [];
  if (cycles.length > 0) {
    const where = [
      eq(orderIntents.runtimeId, runtimeId),
      inArray(
        orderIntents.cycleId,
        cycles.map((c) => c.id),
      ),
    ];
    if (kind === 'working') where.push(inArray(brokerOrders.state, [...WORKING_STATES]));
    const found = await orderQuery(tx)
      .where(and(...where))
      .orderBy(desc(strategyCycles.seq), asc(orderIntents.createdAt), asc(orderIntents.id));
    orders = await withLastPrices(tx, found.map(toOrderRow));
  }
  return { runtimeId, kind, totalCycles: Number(n), cycles, orders };
}

/** Engages or releases the kill switch (§8.1) and returns the new status. */
export async function setKillSwitchByUser(
  tx: Transaction,
  userId: string,
  engaged: boolean,
  reason?: string,
): Promise<ExecutionStatus> {
  await setKillSwitch(tx, userId, engaged, reason);
  return getExecutionStatus(tx);
}

/** Resumes one paused runtime; refused while the kill switch is engaged. */
export async function resumeRuntimeByUser(
  tx: Transaction,
  userId: string,
  runtimeId: string,
): Promise<ExecutionStatus> {
  const [row] = await tx
    .select({ status: strategyRuntimes.status })
    .from(strategyRuntimes)
    .where(eq(strategyRuntimes.id, runtimeId));
  if (!row) throw new OrderError('not_found', 'Strategy run not found');
  if (row.status !== 'paused') throw new OrderError('invalid_state', 'This strategy is not paused');
  // A strategy paused by a plan change resumes only when the plan covers it (ADR 0024).
  // A run on a halted account waits for the halt to end (ADR 0107).
  const halt = await runtimeAccountHalt(tx, runtimeId);
  if (halt) throw new OrderError('invalid_state', haltText(halt.nickname, halt));
  if (!liveTradingEnabled() && (await runtimeMode(tx, runtimeId)) === 'live') {
    throw new OrderError('invalid_state', LIVE_OFF_TEXT);
  }
  await assertCanResume(tx, runtimeId);
  if (!(await resumeRuntime(tx, userId, runtimeId))) {
    throw new OrderError('invalid_state', 'Release the kill switch before resuming a strategy');
  }
  await recordAudit(tx, {
    userId,
    actorType: 'user',
    action: 'runtime.resumed',
    resourceType: 'strategy_runtime',
    resourceId: runtimeId,
  });
  return getExecutionStatus(tx);
}
