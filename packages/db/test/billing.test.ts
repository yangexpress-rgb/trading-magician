import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDefinition, type StrategyDefinition } from '@tm/domain';
import {
  applySubscription,
  billingUserFor,
  claimSubscriptionSyncs,
  getSubscription,
  planPrices,
  recordBillingEvent,
  runBillingGrace,
  type SubscriptionState,
} from '../src/billing';
import type { Transaction } from '../src/client';
import { loadEntitlement, PlanLimitError } from '../src/entitlements';
import { resumeRuntimeByUser } from '../src/order-views';
import { provisionWorkspace } from '../src/provision';
import {
  auditEvents,
  instruments,
  notifications,
  strategyRuntimes,
  subscriptions,
  tradingAccounts,
  users,
} from '../src/schema';
import { createStrategy, startStrategy, updateStrategy } from '../src/strategies';
import { withTenant } from '../src/tenant';
import { createTestDatabase, type TestDatabase } from './harness';

let t: TestDatabase;
let userA: string;
let userB: string;
let userC: string;
let demoA: string;

const as = <T>(userId: string, fn: (tx: Transaction) => Promise<T>) =>
  withTenant(t.app.db, { userId }, fn);

async function createUser(email: string): Promise<string> {
  const [row] = await t.auth.db
    .insert(users)
    .values({ name: email.split('@')[0] ?? email, email })
    .returning({ id: users.id });
  if (!row) throw new Error('user insert failed');
  return row.id;
}

const state = (over: Partial<SubscriptionState> = {}): SubscriptionState => ({
  customerId: 'cus_a',
  subscriptionId: 'sub_a1',
  status: 'active',
  priceId: 'price_test_pro',
  currentPeriodEnd: new Date('2026-11-06T00:00:00Z'),
  cancelAtPeriodEnd: false,
  ...over,
});

const apply = (userId: string, s: SubscriptionState) =>
  as(userId, async (tx) =>
    applySubscription(tx, { userId, state: s, prices: await planPrices(tx), reason: 'test' }),
  );
const planOf = async (userId: string) => (await as(userId, loadEntitlement)).planCode;

beforeAll(async () => {
  t = await createTestDatabase();
  await t.owner.db.execute(sql`update plan set is_default = false`);
  await t.owner.db.execute(sql`update plan set is_default = true where code = 'free'`);
  await t.owner.db.execute(
    sql`update plan set stripe_price_id = 'price_test_pro' where code = 'pro'`,
  );
  userA = await createUser('billing-a@example.test');
  userB = await createUser('billing-b@example.test');
  await provisionWorkspace(t.app.db, { userId: userA, displayName: 'A' });
  await provisionWorkspace(t.app.db, { userId: userB, displayName: 'B' });
  userC = await createUser('billing-c@example.test');
  await provisionWorkspace(t.app.db, { userId: userC, displayName: 'C' });
  demoA = (await t.owner.db.select().from(instruments)).find((r) => r.symbol === 'DEMO-A')!.id;
}, 60_000);

afterAll(async () => {
  await t?.drop();
});

describe('applying a subscription', () => {
  it('moves the workspace to the plan it pays for, once, and tells the person', async () => {
    expect(await planOf(userA)).toBe('free');
    expect(await apply(userA, state())).toEqual({
      fromPlan: 'free',
      toPlan: 'pro',
      changed: true,
      paused: [],
    });
    expect(await planOf(userA)).toBe('pro');
    expect(await as(userA, getSubscription)).toMatchObject({
      planCode: 'pro',
      planName: 'Pro',
      status: 'active',
      customerId: 'cus_a',
      subscriptionId: 'sub_a1',
    });

    // The same state again, as after a replayed event, changes nothing.
    expect(await apply(userA, state())).toMatchObject({ changed: false });
    const audits = await as(userA, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.action, 'subscription.plan_changed')),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.context).toMatchObject({ fromPlan: 'free', toPlan: 'pro', status: 'active' });
    const notes = await as(userA, (tx) =>
      tx.select().from(notifications).where(eq(notifications.kind, 'billing')),
    );
    expect(notes.map((n) => n.title)).toEqual(['You are now on the Pro plan']);
  });

  it('keeps the plan while past due, and returns to Free when it ends', async () => {
    await apply(userA, state({ status: 'past_due' }));
    expect(await planOf(userA)).toBe('pro');
    const statusAudit = await as(userA, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.action, 'subscription.status_changed')),
    );
    expect(statusAudit.at(-1)?.context).toMatchObject({ fromStatus: 'active', status: 'past_due' });

    expect(await apply(userA, state({ status: 'canceled' }))).toMatchObject({
      toPlan: 'free',
      changed: true,
    });
    expect(await planOf(userA)).toBe('free');
  });

  it('never lets a late event about an old subscription undo a newer one', async () => {
    await apply(userA, state({ subscriptionId: 'sub_a2' }));
    expect(await planOf(userA)).toBe('pro');
    expect(await apply(userA, state({ subscriptionId: 'sub_a1', status: 'canceled' }))).toEqual({
      fromPlan: 'pro',
      toPlan: 'pro',
      changed: false,
      paused: [],
    });
    expect(await planOf(userA)).toBe('pro');
    expect((await as(userA, getSubscription)).subscriptionId).toBe('sub_a2');
  });

  it('gives an unknown price the default plan', async () => {
    await apply(
      userB,
      state({ customerId: 'cus_b', subscriptionId: 'sub_b1', priceId: 'price_x' }),
    );
    expect(await planOf(userB)).toBe('free');
  });
});

describe('webhook plumbing', () => {
  it('records each event id once', async () => {
    const event = { id: 'evt_1', type: 'invoice.paid', userId: userA };
    expect(await as(userA, (tx) => recordBillingEvent(tx, event))).toBe(true);
    expect(await as(userA, (tx) => recordBillingEvent(tx, event))).toBe(false);
  });

  it("finds a customer's workspace without a session", async () => {
    expect(await billingUserFor(t.app.db, { customerId: 'cus_b', subscriptionId: null })).toBe(
      userB,
    );
    expect(await billingUserFor(t.app.db, { customerId: null, subscriptionId: 'sub_a2' })).toBe(
      userA,
    );
    expect(
      await billingUserFor(t.app.db, { customerId: 'cus_none', subscriptionId: null }),
    ).toBeNull();
  });

  it('claims subscriptions due a check once until the lease lapses', async () => {
    await t.owner.db
      .update(subscriptions)
      .set({ syncedAt: new Date(Date.now() - 2 * 3600_000) })
      .where(eq(subscriptions.userId, userA));
    const opts = { leaseSeconds: 60, everySeconds: 3600, limit: 10 };
    expect(await claimSubscriptionSyncs(t.app.db, opts)).toEqual([
      { userId: userA, subscriptionId: 'sub_a2' },
    ]);
    expect(await claimSubscriptionSyncs(t.app.db, opts)).toEqual([]);
  });
});

describe('isolation', () => {
  it('lets the app change a subscription only through apply_subscription, for its own tenant', async () => {
    await expect(
      as(userA, (tx) => tx.update(subscriptions).set({ status: 'active' })),
    ).rejects.toThrow();
    await expect(
      as(userA, async (tx) =>
        applySubscription(tx, {
          userId: userB,
          state: state({ customerId: 'cus_b', subscriptionId: 'sub_b1' }),
          prices: await planPrices(tx),
          reason: 'test',
        }),
      ),
    ).rejects.toMatchObject({
      cause: { message: 'apply_subscription is only for the current tenant' },
    });
    expect(await as(userA, (tx) => tx.select().from(subscriptions))).toHaveLength(1);
    expect(
      await as(userA, (tx) =>
        tx
          .select()
          .from(subscriptions)
          .where(and(eq(subscriptions.userId, userB))),
      ),
    ).toEqual([]);
  });
});

function definition(accountId: string): StrategyDefinition {
  const def = createDefinition();
  const series = {
    instrumentId: demoA,
    field: 'close' as const,
    interval: '1d' as const,
    adjustment: 'split_and_dividend' as const,
    session: 'regular' as const,
    offset: 0,
  };
  const cmp = (id: string) => ({
    kind: 'comparison' as const,
    id,
    operator: 'lt' as const,
    left: { kind: 'market' as const, id: `${id}-px`, ...series },
    right: { kind: 'constant' as const, id: `${id}-k`, value: '1' },
  });
  def.entry.condition.children = [cmp('in')];
  def.exit.condition.children = [cmp('out')];
  const leg = {
    instrumentId: demoA,
    accountId,
    quantity: { type: 'units' as const, value: '1', rounding: 'down' as const },
    orderType: 'market' as const,
    timeInForce: 'day' as const,
    extendedHours: false,
    timing: { mode: 'immediate' as const },
    timingOnly: false,
  };
  def.entry.orders = [{ id: 'buy', legLabel: 'Buy', side: 'buy', ...leg }];
  def.exit.orders = [{ id: 'sell', legLabel: 'Sell', side: 'sell', ...leg }];
  return def;
}

async function startRunning(userId: string, name: string) {
  const [account] = await as(userId, (tx) => tx.select().from(tradingAccounts));
  let s = await as(userId, (tx) =>
    createStrategy(tx, userId, { name, definition: definition(account!.id) }),
  );
  s = await as(userId, (tx) =>
    updateStrategy(tx, userId, s.id, { rowVersion: s.rowVersion, status: 'under_testing' }),
  );
  await as(userId, (tx) =>
    startStrategy(tx, userId, s.id, {
      rowVersion: s.rowVersion,
      confirmed: true,
      acknowledgedWarnings: ['no_backtest'],
    }),
  );
  const [runtime] = await as(userId, (tx) =>
    tx.select().from(strategyRuntimes).where(eq(strategyRuntimes.strategyId, s.id)),
  );
  return runtime!.id;
}

describe('a failed payment and running strategies (ADR 0024)', () => {
  const day = 24 * 3600_000;
  const failedAt = new Date('2026-10-06T15:00:00Z');
  const at = (days: number) => new Date(failedAt.getTime() + days * day);
  const sub = (over: Partial<SubscriptionState> = {}) =>
    state({ customerId: 'cus_c', subscriptionId: 'sub_c1', ...over });
  const applyC = (s: SubscriptionState, now: Date) =>
    as(userC, async (tx) =>
      applySubscription(tx, {
        userId: userC,
        state: s,
        prices: await planPrices(tx),
        reason: 'test',
        now,
      }),
    );
  const notes = async () =>
    (
      await as(userC, (tx) =>
        tx
          .select()
          .from(notifications)
          .where(eq(notifications.kind, 'billing'))
          .orderBy(notifications.createdAt),
      )
    ).map((n) => n.title);
  const grace = (now: Date) => runBillingGrace(t.app.db, { prices: (tx) => planPrices(tx), now });
  const runtimes: string[] = [];

  it('keeps the paid plan through a 7-day grace period, with reminders on days 3 and 6', async () => {
    await applyC(sub(), at(-10));
    for (const name of ['First', 'Second', 'Third']) runtimes.push(await startRunning(userC, name));

    await applyC(sub({ status: 'past_due' }), failedAt);
    expect(await planOf(userC)).toBe('pro');
    expect((await as(userC, getSubscription)).graceEndsAt).toEqual(at(7));
    // A later event during the grace period keeps its end.
    await applyC(sub({ status: 'past_due' }), at(1));
    expect((await as(userC, getSubscription)).graceEndsAt).toEqual(at(7));

    await grace(at(2));
    await grace(at(3.1));
    await grace(at(3.5));
    await grace(at(6.2));
    expect(await notes()).toEqual([
      'You are now on the Pro plan',
      'Your payment failed',
      'Your payment is still due: 4 days left',
      'Your payment is still due: 1 day left',
    ]);
  });

  it('moves to Free when the grace period ends and pauses the newest strategies beyond its limit', async () => {
    await grace(at(7.01));
    expect(await planOf(userC)).toBe('free');
    const rows = await as(userC, (tx) => tx.select().from(strategyRuntimes));
    const status = (id: string) => rows.find((r) => r.id === id)?.status;
    expect(runtimes.map(status)).toEqual(['running', 'paused', 'paused']);
    expect(rows.find((r) => r.id === runtimes[2])?.pauseReason).toBe(
      'The Free plan runs 1 strategy at a time.',
    );
    const [last] = (
      await as(userC, (tx) =>
        tx.select().from(notifications).where(eq(notifications.kind, 'billing')),
      )
    ).filter((n) => n.title === 'You are now on the Free plan');
    expect(last?.body).toBe(
      "Your payment was not made within the grace period. Paused because the plan doesn't cover them: Second, Third. Resume them in Orders when your plan allows.",
    );
    const paused = await as(userC, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.action, 'runtime.paused')),
    );
    expect(paused.map((a) => [a.actorType, (a.context as { cause: string }).cause])).toEqual([
      ['system', 'plan_limit'],
      ['system', 'plan_limit'],
    ]);
    // Running the job again changes nothing.
    await grace(at(7.5));
    expect(await notes()).toHaveLength(5);
  });

  it('refuses to resume past the limit, and never restarts anything after an upgrade', async () => {
    await expect(
      as(userC, (tx) => resumeRuntimeByUser(tx, userC, runtimes[1]!)),
    ).rejects.toBeInstanceOf(PlanLimitError);

    await applyC(sub({ subscriptionId: 'sub_c2' }), at(8));
    expect(await planOf(userC)).toBe('pro');
    const rows = await as(userC, (tx) => tx.select().from(strategyRuntimes));
    expect(rows.filter((r) => r.status === 'paused')).toHaveLength(2);
    await as(userC, (tx) => resumeRuntimeByUser(tx, userC, runtimes[1]!));
    const after = await as(userC, (tx) =>
      tx.select().from(strategyRuntimes).where(eq(strategyRuntimes.id, runtimes[1]!)),
    );
    expect(after[0]?.status).toBe('running');
  });
});
