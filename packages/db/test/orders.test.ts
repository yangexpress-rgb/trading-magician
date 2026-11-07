import {
  checkPreTradeRisk,
  createDefinition,
  newCycleState,
  type BrokerUpdate,
  type OrderIntent,
  type StrategyDefinition,
} from '@tm/domain';
import Decimal from 'decimal.js';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Transaction } from '../src/client';
import {
  applyBrokerUpdates,
  getOrderTimeline,
  idempotencyKey,
  markOrderFailed,
  markOrderSubmitted,
  OrderError,
  recordOrderIntent,
} from '../src/orders';
import { provisionWorkspace } from '../src/provision';
import {
  brokerOrders,
  fills,
  instruments,
  orderEvents,
  orderIntents,
  positionSnapshots,
  scheduledActions,
  strategyCycles,
  strategyRuntimes,
  tradingAccounts,
  triggerEvents,
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

const EXECUTION_TABLES = [
  strategyRuntimes,
  strategyCycles,
  triggerEvents,
  scheduledActions,
  orderIntents,
  brokerOrders,
  orderEvents,
  fills,
  positionSnapshots,
] as const;

function pgCode(error: unknown): string | undefined {
  const e = error as { code?: string; cause?: { code?: string } };
  return e.code ?? e.cause?.code;
}
async function expectPgError(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, `expected SQLSTATE ${code}`).toBeDefined();
  expect(pgCode(error)).toBe(code);
}

async function createUser(email: string): Promise<string> {
  const [row] = await t.auth.db
    .insert(users)
    .values({ name: email.split('@')[0] ?? email, email })
    .returning({ id: users.id });
  if (!row) throw new Error('user insert failed');
  return row.id;
}

function definition(account: string): StrategyDefinition {
  const def = createDefinition();
  def.entry.orders = [
    {
      id: 'buy',
      legLabel: 'Buy A',
      instrumentId: demoA,
      accountId: account,
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
  userId: string;
  strategyId: string;
  versionId: string;
  runtimeId: string;
  cycleId: string;
  accountId: string;
}

/** A running runtime with one open cycle, as the worker will create them in M3.3. */
async function startCycle(userId: string, accountId: string): Promise<Cycle> {
  return as(userId, async (tx) => {
    const s = await createStrategy(tx, userId, {
      name: 'Paper',
      definition: definition(accountId),
    });
    const { versionId } = await pinDraftVersion(tx, userId, s.id);
    const [runtime] = await tx
      .insert(strategyRuntimes)
      .values({ userId, strategyId: s.id, versionId, startedBy: userId })
      .returning();
    const [cycle] = await tx
      .insert(strategyCycles)
      .values({
        userId,
        runtimeId: runtime!.id,
        seq: 1,
        entryTriggeredAt: new Date(),
        state: newCycleState(Date.now()),
      })
      .returning();
    return {
      userId,
      strategyId: s.id,
      versionId,
      runtimeId: runtime!.id,
      cycleId: cycle!.id,
      accountId,
    };
  });
}

function intentFor(c: Cycle, overrides: Partial<OrderIntent> = {}): OrderIntent {
  const risk = checkPreTradeRisk({
    risk: { maxOrderNotional: '10000' },
    closing: false,
    quantity: new Decimal(10),
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
    attempt: 1,
    legLabel: 'Buy A',
    triggerEventId: undefined,
    scheduledActionId: undefined,
    eligibleAt: '2026-10-05T13:30:00.000Z',
    accountId: c.accountId,
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
      attempt: 1,
    }),
    source: 'strategy',
    ...overrides,
  };
}

const at = (s: number) => new Date(Date.UTC(2026, 9, 5, 13, 30, s)).toISOString();
const ack: BrokerUpdate = { eventId: 'ack', kind: 'accepted', rawStatus: 'new', at: at(1) };
const fill = (id: string, s: number, quantity: string, price: string): BrokerUpdate => ({
  eventId: id,
  kind: 'fill',
  rawStatus: 'fill',
  at: at(s),
  fill: { quantity, price, fee: '0' },
});

let cycleA: Cycle;
let attempt = 100;
/** A fresh submitted order for user A. */
async function submittedOrder(): Promise<string> {
  attempt += 1;
  const key = idempotencyKey({
    runtimeId: cycleA.runtimeId,
    cycleId: cycleA.cycleId,
    phase: 'entry',
    legId: 'buy',
    attempt,
  });
  return asA(async (tx) => {
    const { intentId } = await recordOrderIntent(
      tx,
      userA,
      intentFor(cycleA, { idempotencyKey: key }),
    );
    await markOrderSubmitted(tx, intentId, `paper-${attempt}`);
    return intentId;
  });
}

beforeAll(async () => {
  t = await createTestDatabase();
  userA = await createUser('a@example.test');
  userB = await createUser('b@example.test');
  await provisionWorkspace(t.app.db, { userId: userA, displayName: 'A' });
  await provisionWorkspace(t.app.db, { userId: userB, displayName: 'B' });
  const rows = await t.owner.db.select().from(instruments);
  demoA = rows.find((r) => r.symbol === 'DEMO-A')!.id;
  accountA = (await asA((tx) => tx.select().from(tradingAccounts)))[0]!.id;
  cycleA = await startCycle(userA, accountA);
}, 60_000);

afterAll(async () => {
  await t?.drop();
});

describe('idempotency keys', () => {
  it('are deterministic, broker-sized, and change only with their parts', () => {
    const parts = { runtimeId: 'r', cycleId: 'c', phase: 'entry' as const, legId: 'l', attempt: 1 };
    const key = idempotencyKey(parts);
    expect(key).toHaveLength(36);
    expect(idempotencyKey({ ...parts })).toBe(key);
    expect(idempotencyKey({ ...parts, attempt: 2 })).not.toBe(key);
    expect(idempotencyKey({ ...parts, phase: 'exit' })).not.toBe(key);
  });
});

describe('recording intents', () => {
  it('stores a risk-approved intent as ready, with its risk check in the timeline', async () => {
    const intent = intentFor(cycleA);
    const first = await asA((tx) => recordOrderIntent(tx, userA, intent));
    expect(first).toMatchObject({ created: true, state: 'ready' });
    const timeline = await asA((tx) => getOrderTimeline(tx, first.intentId));
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({ source: 'app', fromState: 'planned', toState: 'ready' });
  });

  it('never creates a second order for the same idempotency key', async () => {
    const intent = intentFor(cycleA);
    const again = await asA((tx) => recordOrderIntent(tx, userA, { ...intent, quantity: '99' }));
    expect(again).toMatchObject({ created: false, state: 'ready' });
    const rows = await asA((tx) =>
      tx.select().from(orderIntents).where(eq(orderIntents.idempotencyKey, intent.idempotencyKey)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.quantity).toBe('10');
  });

  it('records a risk rejection that can never reach a broker', async () => {
    const risk = checkPreTradeRisk({
      risk: { maxOrderNotional: '500' },
      closing: false,
      quantity: new Decimal(10),
      referencePrice: new Decimal(100),
      activeOrders: 0,
      grossExposure: new Decimal(0),
      equity: new Decimal(100_000),
      dailyLossHit: false,
      drawdownHit: false,
      openPositions: 0,
      instrumentHeld: false,
    });
    const intent = intentFor(cycleA, {
      risk,
      idempotencyKey: 'tm1-risk-rejected-test-000000000000',
    });
    const r = await asA((tx) => recordOrderIntent(tx, userA, intent));
    expect(r.state).toBe('rejected');
    const [order] = await asA((tx) =>
      tx.select().from(brokerOrders).where(eq(brokerOrders.intentId, r.intentId)),
    );
    expect(order!.reason).toBe('Risk check failed: risk_order_size');
    expect(order!.terminalAt).not.toBeNull();
    const error = await asA((tx) => applyBrokerUpdates(tx, r.intentId, [ack])).catch((e) => e);
    expect(error).toBeInstanceOf(OrderError);
    expect((error as OrderError).code).toBe('invalid_state');
  });

  it('marks a failed submission as terminal', async () => {
    const intentId = await asA(async (tx) => {
      const r = await recordOrderIntent(
        tx,
        userA,
        intentFor(cycleA, { idempotencyKey: 'tm1-submit-failed-test-00000000000' }),
      );
      await markOrderFailed(tx, r.intentId, 'Broker unreachable');
      return r.intentId;
    });
    const [order] = await asA((tx) =>
      tx.select().from(brokerOrders).where(eq(brokerOrders.intentId, intentId)),
    );
    expect(order).toMatchObject({ state: 'failed', reason: 'Broker unreachable' });
  });
});

describe('broker updates', () => {
  it('converge whatever their arrival order, and ignore repeats', async () => {
    const one = await submittedOrder();
    const two = await submittedOrder();
    const updates = [ack, fill('f1', 2, '4', '100'), fill('f2', 3, '6', '101')];

    await asA((tx) => applyBrokerUpdates(tx, one, updates));
    // The same updates, reversed, split across deliveries, with repeats.
    await asA((tx) => applyBrokerUpdates(tx, two, [updates[2]!, updates[2]!]));
    await asA((tx) => applyBrokerUpdates(tx, two, [updates[1]!]));
    const last = await asA((tx) => applyBrokerUpdates(tx, two, [updates[0]!, updates[1]!]));
    expect(last).toEqual({ state: 'filled', applied: 1 });

    const rows = await asA((tx) =>
      tx
        .select()
        .from(brokerOrders)
        .where(sql`${brokerOrders.intentId} in (${one}, ${two})`),
    );
    const pick = (r: (typeof rows)[number]) => ({
      state: r.state,
      filled: r.filledQuantity,
      avg: r.averagePrice,
      fees: r.fees,
      acknowledgedAt: r.acknowledgedAt,
      filledAt: r.filledAt,
    });
    expect(rows).toHaveLength(2);
    expect(pick(rows[0]!)).toEqual(pick(rows[1]!));
    expect(pick(rows[0]!)).toMatchObject({ state: 'filled', filled: '10', avg: '100.6' });

    const stored = await asA((tx) => tx.select().from(fills).where(eq(fills.intentId, two)));
    expect(stored).toHaveLength(2);
  });

  it('keeps a full timeline from planning to fill', async () => {
    const id = await submittedOrder();
    await asA((tx) => applyBrokerUpdates(tx, id, [ack, fill('f1', 2, '10', '100')]));
    const timeline = await asA((tx) => getOrderTimeline(tx, id));
    expect(timeline.map((e) => [e.source, e.fromState, e.toState])).toEqual([
      ['app', 'planned', 'ready'],
      ['app', 'ready', 'submitted'],
      ['broker', 'submitted', 'acknowledged'],
      ['broker', 'acknowledged', 'filled'],
    ]);
  });

  it('keeps the filled part of a canceled order', async () => {
    const id = await submittedOrder();
    const r = await asA((tx) =>
      applyBrokerUpdates(tx, id, [
        ack,
        fill('f1', 2, '4', '100'),
        { eventId: 'c', kind: 'canceled', rawStatus: 'canceled', at: at(5) },
      ]),
    );
    expect(r.state).toBe('canceled');
    const [order] = await asA((tx) =>
      tx.select().from(brokerOrders).where(eq(brokerOrders.intentId, id)),
    );
    expect(order).toMatchObject({ filledQuantity: '4', rawStatus: 'canceled' });
  });
});

describe('append-only records', () => {
  it('lets no one change an intent, an order event or a fill', async () => {
    const id = await submittedOrder();
    await asA((tx) => applyBrokerUpdates(tx, id, [fill('f1', 2, '10', '100')]));
    // The app has no UPDATE or DELETE grant on these tables.
    await expectPgError(
      asA((tx) => tx.update(orderIntents).set({ quantity: '1' }).where(eq(orderIntents.id, id))),
      '42501',
    );
    await expectPgError(
      asA((tx) => tx.delete(fills).where(eq(fills.intentId, id))),
      '42501',
    );
    // Even the owner is stopped by the trigger.
    for (const table of ['order_intent', 'order_event', 'fill']) {
      const column = table === 'order_intent' ? 'id' : 'intent_id';
      await expectPgError(
        t.ownerSql.unsafe(`update ${table} set user_id = user_id where ${column} = $1`, [id]),
        '42501',
      );
      await expectPgError(
        t.ownerSql.unsafe(`delete from ${table} where ${column} = $1`, [id]),
        '42501',
      );
    }
  });

  it('still lets account deletion remove them', async () => {
    const userC = await createUser('c@example.test');
    await provisionWorkspace(t.app.db, { userId: userC, displayName: 'C' });
    const accountC = (await as(userC, (tx) => tx.select().from(tradingAccounts)))[0]!.id;
    const c = await startCycle(userC, accountC);
    const { intentId } = await as(userC, (tx) => recordOrderIntent(tx, userC, intentFor(c)));
    await as(userC, async (tx) => {
      await markOrderSubmitted(tx, intentId, 'paper-c');
      await applyBrokerUpdates(tx, intentId, [fill('f1', 1, '10', '100')]);
    });
    await t.owner.db.delete(users).where(eq(users.id, userC));
    const left =
      await t.ownerSql`select count(*)::int as n from order_intent where user_id = ${userC}`;
    expect(left[0]!.n).toBe(0);
  });
});

describe('tenant isolation', () => {
  it("shows another tenant none of a tenant's execution rows", async () => {
    await submittedOrder();
    for (const table of EXECUTION_TABLES) {
      const theirs = await as(userB, (tx) => tx.select().from(table));
      expect(theirs).toEqual([]);
    }
    expect((await asA((tx) => tx.select().from(orderIntents))).length).toBeGreaterThan(0);
  });

  it("rejects an intent that points at another tenant's runtime", async () => {
    const accountB = (await as(userB, (tx) => tx.select().from(tradingAccounts)))[0]!.id;
    await expectPgError(
      as(userB, (tx) =>
        recordOrderIntent(
          tx,
          userB,
          intentFor(
            { ...cycleA, userId: userB, accountId: accountB },
            {
              idempotencyKey: 'tm1-cross-tenant-test-000000000000',
            },
          ),
        ),
      ),
      '23503',
    );
  });
});

describe('runtime constraints', () => {
  it('allows only paper runtimes and intents', async () => {
    await expectPgError(
      t.ownerSql`update strategy_runtime set mode = 'live' where id = ${cycleA.runtimeId}`,
      '23514',
    );
    await expectPgError(
      t.ownerSql`update broker_order set filled_quantity = -1 where user_id = ${userA}`,
      '23514',
    );
  });

  it('allows one active runtime per strategy', async () => {
    await expectPgError(
      asA((tx) =>
        tx.insert(strategyRuntimes).values({
          userId: userA,
          strategyId: cycleA.strategyId,
          versionId: cycleA.versionId,
          startedBy: userA,
        }),
      ),
      '23505',
    );
    await asA(async (tx) => {
      await tx
        .update(strategyRuntimes)
        .set({ status: 'stopped', stoppedAt: new Date(), stoppedBy: userA })
        .where(eq(strategyRuntimes.id, cycleA.runtimeId));
      await tx.insert(strategyRuntimes).values({
        userId: userA,
        strategyId: cycleA.strategyId,
        versionId: cycleA.versionId,
        startedBy: userA,
      });
    });
  });
});
