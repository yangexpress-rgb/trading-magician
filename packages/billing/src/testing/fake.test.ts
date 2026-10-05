import { describe, expect, it } from 'vitest';
import type { BillingEvent } from '../types';
import { FakeStripe } from './fake';

describe('FakeStripe', () => {
  function fake() {
    const received: BillingEvent[] = [];
    const stripe: FakeStripe = new FakeStripe({
      webhookSecret: 'whsec_fake',
      pagesUrl: 'http://localhost:3000/billing-fake',
      deliver: async (payload, signature) => {
        received.push(stripe.parseWebhook(payload, signature));
      },
    });
    return { stripe, received };
  }

  it('runs a checkout and sends signed events the real parser reads', async () => {
    const { stripe, received } = fake();
    const session = await stripe.createCheckoutSession({
      userId: 'u1',
      email: 'trader@example.test',
      priceId: 'price_pro',
      successUrl: 'http://localhost:3000/settings/billing?checkout=done',
      cancelUrl: 'http://localhost:3000/settings/billing',
    });
    expect(session.url).toMatch(/\/billing-fake\/checkout\/cs_fake/);
    expect(await stripe.completeCheckout(session.id)).toMatch(/checkout=done$/);
    expect(received.map((e) => e.type)).toEqual([
      'customer.subscription.created',
      'checkout.session.completed',
    ]);
    const subscriptionId = received[1]!.subscriptionId!;
    expect(received[1]).toMatchObject({ userId: 'u1' });
    expect(await stripe.getSubscription(subscriptionId)).toMatchObject({
      status: 'active',
      priceId: 'price_pro',
      userId: 'u1',
      cancelAtPeriodEnd: false,
    });
    await expect(stripe.completeCheckout(session.id)).rejects.toThrow();

    await stripe.failPayment(subscriptionId);
    expect((await stripe.getSubscription(subscriptionId))?.status).toBe('past_due');
    await stripe.setCancelAtPeriodEnd(subscriptionId, true);
    await stripe.endPeriod(subscriptionId);
    expect((await stripe.getSubscription(subscriptionId))?.status).toBe('canceled');

    const count = received.length;
    await stripe.replay();
    expect(received.slice(count).map((e) => e.id)).toEqual(
      received.slice(0, count).map((e) => e.id),
    );
  });
});
