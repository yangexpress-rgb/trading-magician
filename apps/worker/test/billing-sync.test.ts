import { FakeStripe } from '@tm/billing/testing';
import {
  applySubscription,
  getSubscription,
  loadEntitlement,
  planPrices,
  provisionWorkspace,
  schema,
  sql,
  withTenant,
  type Transaction,
} from '@tm/db';
import { createTestDatabase, type TestDatabase } from '@tm/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSubscriptionSyncs } from '../src/billing-sync';

let t: TestDatabase;
let userId: string;
const quiet = { info: () => undefined, warn: () => undefined };
const asUser = <T>(fn: (tx: Transaction) => Promise<T>) => withTenant(t.app.db, { userId }, fn);
// Webhooks are "lost": the fake sends them nowhere, so only the re-sync can catch up.
const stripe = new FakeStripe({
  webhookSecret: 'whsec_test',
  pagesUrl: 'http://localhost/billing-fake',
  deliver: async () => undefined,
});

beforeAll(async () => {
  t = await createTestDatabase();
  await t.owner.db.execute(sql`update plan set is_default = false`);
  await t.owner.db.execute(sql`update plan set is_default = true where code = 'free'`);
  await t.owner.db.execute(
    sql`update plan set stripe_price_id = 'price_test_pro' where code = 'pro'`,
  );
  const [user] = await t.auth.db
    .insert(schema.users)
    .values({ name: 'Payer', email: 'payer@example.test' })
    .returning({ id: schema.users.id });
  userId = user!.id;
  await provisionWorkspace(t.app.db, { userId, displayName: 'Payer' });
}, 60_000);

afterAll(async () => {
  await t?.drop();
});

describe('subscription re-sync', () => {
  it('catches up with a cancellation whose webhook never arrived', async () => {
    const session = await stripe.createCheckoutSession({
      userId,
      email: 'payer@example.test',
      priceId: 'price_test_pro',
      successUrl: 'http://localhost/settings/billing',
      cancelUrl: 'http://localhost/settings/billing',
    });
    await stripe.completeCheckout(session.id);
    const [sub] = [...stripe.subscriptions.values()];
    const remote = (await stripe.getSubscription(sub!.id))!;
    await asUser(async (tx) =>
      applySubscription(tx, {
        userId,
        state: { ...remote, subscriptionId: remote.id },
        prices: await planPrices(tx),
        reason: 'test',
      }),
    );
    expect((await asUser(loadEntitlement)).planCode).toBe('pro');

    await stripe.cancelNow(sub!.id);
    // Not due yet: synced within the hour.
    expect(await runSubscriptionSyncs({ db: t.worker.db, provider: stripe, logger: quiet })).toBe(
      0,
    );
    await t.owner.db
      .update(schema.subscriptions)
      .set({ syncedAt: new Date(Date.now() - 2 * 3600_000) });
    expect(await runSubscriptionSyncs({ db: t.worker.db, provider: stripe, logger: quiet })).toBe(
      1,
    );
    expect((await asUser(loadEntitlement)).planCode).toBe('free');
    expect((await asUser(getSubscription)).status).toBe('canceled');
    // A cancelled subscription is not checked again.
    await t.owner.db
      .update(schema.subscriptions)
      .set({ syncedAt: new Date(Date.now() - 2 * 3600_000) });
    expect(await runSubscriptionSyncs({ db: t.worker.db, provider: stripe, logger: quiet })).toBe(
      0,
    );
  });
});
