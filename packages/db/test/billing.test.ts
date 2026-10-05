import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applySubscription,
  billingUserFor,
  claimSubscriptionSyncs,
  getSubscription,
  planPrices,
  recordBillingEvent,
  type SubscriptionState,
} from '../src/billing';
import type { Transaction } from '../src/client';
import { loadEntitlement } from '../src/entitlements';
import { provisionWorkspace } from '../src/provision';
import { auditEvents, notifications, subscriptions, users } from '../src/schema';
import { withTenant } from '../src/tenant';
import { createTestDatabase, type TestDatabase } from './harness';

let t: TestDatabase;
let userA: string;
let userB: string;

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
}, 60_000);

afterAll(async () => {
  await t?.drop();
});

describe('applying a subscription', () => {
  it('moves the workspace to the plan it pays for, once, and tells the person', async () => {
    expect(await planOf(userA)).toBe('free');
    expect(await apply(userA, state())).toEqual({ fromPlan: 'free', toPlan: 'pro', changed: true });
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
