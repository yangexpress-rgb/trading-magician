import {
  checkPreTradeRisk,
  createDefinition,
  newCycleState,
  type BrokerUpdate,
  type OrderIntent,
  type StrategyDefinition,
} from '@tm/domain';
import Decimal from 'decimal.js';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Transaction } from '../src/client';
import { listOpenIncidents, openIncident, resolveIncident } from '../src/incidents';
import { listenForExecutionChanges } from '../src/notify';
import { listNotifications, markNotificationsRead, notify } from '../src/notifications';
import {
  cancelOrderByUser,
  closePositions,
  getExecutionStatus,
  getOrderDetail,
  listOrders,
  listPositions,
  resumeRuntimeByUser,
  setKillSwitchByUser,
} from '../src/order-views';
import {
  applyBrokerUpdates,
  idempotencyKey,
  markOrderSubmitted,
  OrderError,
  recordOrderIntent,
} from '../src/orders';
import { provisionWorkspace } from '../src/provision';
import { stopRuntime } from '../src/runtime';
import {
  auditEvents,
  notifications,
  instruments,
  scheduledActions,
  strategyCycles,
  strategyRuntimes,
  tradingAccounts,
  users,
} from '../src/schema';
import { createStrategy, pinDraftVersion } from '../src/strategies';
import { withTenant } from '../src/tenant';
import { createTestDatabase, type TestDatabase } from './harness';

let t: TestDatabase;
let userA: string;
let userB: string;
let demoA: string;
let accountA: string;

const as = <T>(userId: string, fn: (tx: Transaction) => Promise<T>) =>
  withTenant(t.app.db, { userId }, fn);
const asA = <T>(fn: (tx: Transaction) => Promise<T>) => as(userA, fn);

async function createUser(email: string): Promise<string> {
  const [row] = await t.auth.db
    .insert(users)
    .values({ name: email.split('@')[0] ?? email, email })
    .returning({ id: users.id });
  if (!row) throw new Error('user insert failed');
  return row.id;
}

function definition(): StrategyDefinition {
  const def = createDefinition();
  def.entry.orders = [
    {
      id: 'buy',
      legLabel: 'Buy A',
      instrumentId: demoA,
      accountId: accountA,
      side: 'buy',
      quantity: { type: 'units', value: '10', rounding: 'down' },
      orderType: 'market',
      timeInForce: 'day',
      timing: { mode: 'immediate' },
    },
  ];
  return def;
}

interface Cycle {
  strategyId: string;
  versionId: string;
  runtimeId: string;
  cycleId: string;
}

async function startCycle(name: string): Promise<Cycle> {
  return asA(async (tx) => {
    const s = await createStrategy(tx, userA, { name, definition: definition() });
    const { versionId } = await pinDraftVersion(tx, userA, s.id);
    const [runtime] = await tx
      .insert(strategyRuntimes)
      .values({ userId: userA, strategyId: s.id, versionId, startedBy: userA })
      .returning();
    const [cycle] = await tx
      .insert(strategyCycles)
      .values({
        userId: userA,
        runtimeId: runtime!.id,
        seq: 1,
        entryTriggeredAt: new Date(),
        state: newCycleState(Date.now()),
      })
      .returning();
    return { strategyId: s.id, versionId, runtimeId: runtime!.id, cycleId: cycle!.id };
  });
}

let n = 0;
function intentFor(c: Cycle, overrides: Partial<OrderIntent> = {}): OrderIntent {
  n += 1;
  const risk = checkPreTradeRisk({
    risk: { maxOrderNotional: '10000' },
    closing: false,
    quantity: new Decimal(overrides.quantity ?? 10),
    referencePrice: new Decimal(100),
    activeOrders: 0,
    grossExposure: new Decimal(0),
    equity: new Decimal(100_000),
    dailyLossHit: false,
    drawdownHit: false,
    openPositions: 0,
    instrumentHeld: false,
  });
  return {
    runtimeId: c.runtimeId,
    strategyId: c.strategyId,
    versionId: c.versionId,
    cycleId: c.cycleId,
    phase: 'entry',
    plannedOrderId: 'buy',
    attempt: n,
    legLabel: 'Buy A',
    triggerEventId: undefined,
    scheduledActionId: undefined,
    eligibleAt: new Date().toISOString(),
    accountId: accountA,
    instrumentId: demoA,
    side: 'buy',
    direction: 'buy',
    quantity: '10',
    orderType: 'market',
    limitPrice: undefined,
    stopPrice: undefined,
    timeInForce: 'day',
    extendedHours: false,
    referencePrice: '100',
    risk,
    idempotencyKey: idempotencyKey({
      runtimeId: c.runtimeId,
      cycleId: c.cycleId,
      phase: 'entry',
      legId: 'buy',
      attempt: n,
    }),
    source: 'strategy',
    ...overrides,
  };
}

const update = (eventId: string, kind: BrokerUpdate['kind'], extra = {}): BrokerUpdate => ({
  eventId,
  kind,
  rawStatus: kind,
  at: new Date().toISOString(),
  ...extra,
});

/** Records, submits and optionally fills an order. */
async function order(c: Cycle, outcome: 'working' | 'filled' | 'rejected') {
  return asA(async (tx) => {
    const { intentId } = await recordOrderIntent(
      tx,
      userA,
      intentFor(c, outcome === 'rejected' ? { quantity: '1000' } : {}),
    );
    if (outcome === 'rejected') return intentId;
    await markOrderSubmitted(tx, intentId, `paper-${intentId}`);
    const updates = [update(`ack-${intentId}`, 'accepted')];
    if (outcome === 'filled') {
      updates.push(
        update(`fill-${intentId}`, 'fill', { fill: { quantity: '10', price: '100', fee: '0' } }),
      );
    }
    await applyBrokerUpdates(tx, intentId, updates);
    return intentId;
  });
}

async function expectOrderError(promise: Promise<unknown>, code: OrderError['code']) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OrderError);
  expect((error as OrderError).code).toBe(code);
}

let cycle: Cycle;
let filled: string;
let working: string;
let rejected: string;

beforeAll(async () => {
  t = await createTestDatabase();
  userA = await createUser('a@example.test');
  userB = await createUser('b@example.test');
  await provisionWorkspace(t.app.db, { userId: userA, displayName: 'A' });
  await provisionWorkspace(t.app.db, { userId: userB, displayName: 'B' });
  const rows = await t.owner.db.select().from(instruments);
  demoA = rows.find((r) => r.symbol === 'DEMO-A')!.id;
  accountA = (await asA((tx) => tx.select().from(tradingAccounts)))[0]!.id;
  cycle = await startCycle('Views');
  filled = await order(cycle, 'filled');
  working = await order(cycle, 'working');
  rejected = await order(cycle, 'rejected');
}, 60_000);

afterAll(async () => {
  await t?.drop();
});

describe('listing orders (§8.3, §14.3)', () => {
  it('counts each view and filters by state', async () => {
    const all = await asA((tx) => listOrders(tx, { runtimeId: cycle.runtimeId }));
    expect(all.counts).toEqual({ all: 3, working: 1, filled: 1, closed: 1, scheduled: 0 });
    expect(all.orders.map((o) => o.id).sort()).toEqual([filled, working, rejected].sort());
    expect(all.orders[0]).toMatchObject({
      mode: 'paper',
      source: 'strategy',
      strategyName: 'Views',
      cycleSeq: 1,
      phase: 'entry',
      symbol: 'DEMO-A',
      accountName: expect.any(String),
    });

    const byView = async (view: 'working' | 'filled' | 'closed') =>
      (await asA((tx) => listOrders(tx, { runtimeId: cycle.runtimeId, view }))).orders.map(
        (o) => o.id,
      );
    expect(await byView('working')).toEqual([working]);
    expect(await byView('filled')).toEqual([filled]);
    expect(await byView('closed')).toEqual([rejected]);
    const f = (await asA((tx) => listOrders(tx, { view: 'filled', cycleId: cycle.cycleId })))
      .orders[0];
    expect(f).toMatchObject({ state: 'filled', filledQuantity: '10', averagePrice: '100' });
  });

  it('filters by phase and date in the viewer time zone', async () => {
    const exit = await asA((tx) => listOrders(tx, { runtimeId: cycle.runtimeId, phase: 'exit' }));
    expect(exit.counts.all).toBe(0);
    const today = new Date().toISOString().slice(0, 10);
    const inRange = await asA((tx) =>
      listOrders(tx, { runtimeId: cycle.runtimeId, from: today, to: today, timeZone: 'UTC' }),
    );
    expect(inRange.counts.all).toBe(3);
    const before = await asA((tx) =>
      listOrders(tx, { runtimeId: cycle.runtimeId, to: '2020-01-01', timeZone: 'UTC' }),
    );
    expect(before.counts.all).toBe(0);
  });

  it('lists legs waiting on timing as scheduled, with their planned leg', async () => {
    const c = await startCycle('Scheduled');
    await asA((tx) =>
      tx.insert(scheduledActions).values({
        userId: userA,
        runtimeId: c.runtimeId,
        cycleId: c.cycleId,
        kind: 'submit_leg',
        phase: 'entry',
        legId: 'buy',
        dueAt: new Date(Date.now() + 300_000),
        dedupeKey: `test:${c.cycleId}`,
      }),
    );
    const list = await asA((tx) => listOrders(tx, { runtimeId: c.runtimeId, view: 'scheduled' }));
    expect(list.orders).toEqual([]);
    expect(list.counts.scheduled).toBe(1);
    expect(list.scheduled[0]).toMatchObject({
      strategyName: 'Scheduled',
      legLabel: 'Buy A',
      symbol: 'DEMO-A',
      side: 'buy',
      phase: 'entry',
    });
  });

  it('shows another user nothing', async () => {
    const list = await as(userB, (tx) => listOrders(tx));
    expect(list.counts.all).toBe(0);
    await expectOrderError(
      as(userB, (tx) => getOrderDetail(tx, filled)),
      'not_found',
    );
  });
});

describe('order detail', () => {
  it('has the timeline, fills and the rule the order came from', async () => {
    const d = await asA((tx) => getOrderDetail(tx, filled));
    expect(d.timeline.map((e) => [e.source, e.toState])).toEqual([
      ['app', 'ready'],
      ['app', 'submitted'],
      ['broker', 'acknowledged'],
      ['broker', 'filled'],
    ]);
    expect(d.timeline[0]!.kind).toBe('risk_check');
    expect(d.fills).toEqual([expect.objectContaining({ quantity: '10', price: '100' })]);
    expect(d.sourceRule.plannedOrder).toMatchObject({ id: 'buy', legLabel: 'Buy A' });
    expect(d.sourceRule.trigger).toMatchObject({ mode: expect.any(String) });
    expect(d.versionNo).toBe(1);
    expect(d.idempotencyKey).toMatch(/^tm1-/);
  });
});

describe('manual cancel', () => {
  it('records the request as the person’s, and refuses orders that are done', async () => {
    const d = await asA((tx) => cancelOrderByUser(tx, userA, working));
    expect(d.cancelRequested).toBe(true);
    expect(d.timeline.at(-1)).toMatchObject({ source: 'user', kind: 'cancel_requested' });
    await expectOrderError(
      asA((tx) => cancelOrderByUser(tx, userA, filled)),
      'invalid_state',
    );
    const audit = await asA((tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.resourceId, working)),
    );
    expect(audit.map((a) => a.action)).toContain('order.cancel_requested');
  });
});

describe('positions and manual close', () => {
  it('derives holdings from fills and closes them only once the strategy is stopped', async () => {
    const c = await startCycle('Holder');
    await order(c, 'filled');
    const [p] = await asA((tx) => listPositions(tx, { runtimeId: c.runtimeId }));
    expect(p).toMatchObject({
      symbol: 'DEMO-A',
      quantity: '10',
      averageCost: '100',
      runtimeStatus: 'running',
      closing: false,
    });

    await expectOrderError(
      asA((tx) => closePositions(tx, userA, { runtimeId: c.runtimeId })),
      'invalid_state',
    );
    await asA((tx) => stopRuntime(tx, userA, c.strategyId));
    expect(await asA((tx) => closePositions(tx, userA, { runtimeId: c.runtimeId }))).toEqual({
      orders: 1,
    });
    const closes = await asA((tx) => listOrders(tx, { runtimeId: c.runtimeId, phase: 'flatten' }));
    expect(closes.orders).toEqual([
      expect.objectContaining({
        source: 'user',
        side: 'sell',
        quantity: '10',
        state: 'ready',
        legLabel: 'Close DEMO-A',
      }),
    ]);
    const [after] = await asA((tx) => listPositions(tx, { runtimeId: c.runtimeId }));
    expect(after!.closing).toBe(true);
    await expectOrderError(
      asA((tx) => closePositions(tx, userA, { runtimeId: c.runtimeId })),
      'invalid_state',
    );
  });
});

describe('kill switch and resume', () => {
  it('pauses runtimes, blocks resuming until released, and shows in the status', async () => {
    const c = await startCycle('Pausable');
    let status = await asA((tx) => setKillSwitchByUser(tx, userA, true, 'test'));
    expect(status.halted).toMatchObject({ reason: 'test' });
    expect(status.runtimes.find((r) => r.id === c.runtimeId)).toMatchObject({
      status: 'paused',
      pauseReason: 'Kill switch engaged',
    });
    await expectOrderError(
      asA((tx) => resumeRuntimeByUser(tx, userA, c.runtimeId)),
      'invalid_state',
    );
    status = await asA((tx) => setKillSwitchByUser(tx, userA, false));
    expect(status.halted).toBeNull();
    status = await asA((tx) => resumeRuntimeByUser(tx, userA, c.runtimeId));
    expect(status.runtimes.find((r) => r.id === c.runtimeId)?.status).toBe('running');
    expect((await as(userB, (tx) => getExecutionStatus(tx))).runtimes).toEqual([]);
  });
});

describe('change notices', () => {
  it('notify the owning user id when an order changes', async () => {
    const seen: string[] = [];
    const listener = await listenForExecutionChanges(t.appUrl, (id) => seen.push(id));
    try {
      await order(cycle, 'working');
      await expect.poll(() => seen, { timeout: 5_000 }).toContain(userA);
      expect(seen.every((id) => id === userA)).toBe(true);
    } finally {
      await listener.close();
    }
  });
});

describe('notifications (§16.3)', () => {
  it('stores each event once, counts unread, and marks read', async () => {
    const before = (await asA((tx) => listNotifications(tx))).unread;
    for (let i = 0; i < 2; i++) {
      await asA((tx) =>
        notify(tx, {
          userId: userA,
          kind: 'filled',
          title: 'Test notice',
          link: '/orders',
          dedupeKey: 'test:filled',
        }),
      );
    }
    const list = await asA((tx) => listNotifications(tx));
    expect(list.unread).toBe(before + 1);
    expect(list.notifications.filter((n) => n.title === 'Test notice')).toHaveLength(1);
    expect(await asA((tx) => markNotificationsRead(tx, 'all'))).toBe(list.unread);
    expect((await asA((tx) => listNotifications(tx))).unread).toBe(0);
    expect((await as(userB, (tx) => listNotifications(tx))).notifications).toEqual([]);
  });

  it('lets the app change only the read time, and only to in-app links', async () => {
    const error = await asA((tx) =>
      tx.update(notifications).set({ title: 'changed' }).where(eq(notifications.userId, userA)),
    ).then(
      () => undefined,
      (e: unknown) => e as { code?: string; cause?: { code?: string } },
    );
    expect(error?.code ?? error?.cause?.code).toBe('42501');
    await expect(
      asA((tx) =>
        notify(tx, { userId: userA, kind: 'filled', title: 'x', link: 'https://evil.test' }),
      ),
    ).rejects.toThrow();
  });

  it('records order fills and strategy-level events as notifications', async () => {
    const kinds = (await asA((tx) => listNotifications(tx, { limit: 200 }))).notifications.map(
      (n) => n.kind,
    );
    expect(kinds).toContain('filled');
    expect(kinds).toContain('order_rejected');
  });
});

describe('incidents (§8.5, §8.6)', () => {
  it('opens once per subject, pauses what it affects, and is resolved by a person', async () => {
    const c = await startCycle('Incident');
    const input = {
      userId: userA,
      kind: 'repeated_rejects' as const,
      runtimeId: c.runtimeId,
      summary: 'Paused after 3 rejected orders.',
      pause: [c.runtimeId],
    };
    const first = await asA((tx) => openIncident(tx, input));
    const again = await asA((tx) => openIncident(tx, input));
    expect(first.created).toBe(true);
    expect(again).toEqual({ incidentId: first.incidentId, created: false });
    const status = await asA((tx) => getExecutionStatus(tx));
    expect(status.incidents.map((i) => i.id)).toContain(first.incidentId);
    expect(status.runtimes.find((r) => r.id === c.runtimeId)).toMatchObject({
      status: 'paused',
      pauseReason: 'Paused after 3 rejected orders.',
    });
    expect((await as(userB, (tx) => listOpenIncidents(tx))).length).toBe(0);

    await asA((tx) =>
      resolveIncident(tx, {
        userId: userA,
        incidentId: first.incidentId,
        by: 'user',
        note: 'Checked',
      }),
    );
    await expectOrderError(
      asA((tx) => resolveIncident(tx, { userId: userA, incidentId: first.incidentId, by: 'user' })),
      'not_found',
    );
    const audit = await asA((tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.resourceId, first.incidentId)),
    );
    expect(audit.map((a) => a.action).sort()).toEqual(['incident.opened', 'incident.resolved']);
  });
});
