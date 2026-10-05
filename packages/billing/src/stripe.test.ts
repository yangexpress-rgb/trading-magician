import { describe, expect, it } from 'vitest';
import { signWebhook, verifyWebhook } from './signature';
import {
  assertTestModeKey,
  LiveBillingKeyError,
  readEvent,
  readSubscription,
  StripeBilling,
  type Fetch,
} from './stripe';
import { BillingRequestError, BillingUnavailableError, WebhookSignatureError } from './types';

const KEY = 'sk_test_51FakeKeyForTests0000000000';
const SECRET = 'whsec_test_secret';
const at = new Date('2026-10-06T15:00:00Z');

describe('webhook signatures', () => {
  const payload = '{"id":"evt_1","type":"invoice.paid"}';

  it('accepts a genuine event and refuses a changed, unsigned, wrongly signed or old one', () => {
    const header = signWebhook(payload, SECRET, at);
    expect(() => verifyWebhook(payload, header, SECRET, at)).not.toThrow();
    expect(() => verifyWebhook(`${payload} `, header, SECRET, at)).toThrow(WebhookSignatureError);
    expect(() => verifyWebhook(payload, null, SECRET, at)).toThrow(/no signature/);
    expect(() => verifyWebhook(payload, 't=1,v1=zz', SECRET, at)).toThrow(WebhookSignatureError);
    expect(() => verifyWebhook(payload, signWebhook(payload, 'other', at), SECRET, at)).toThrow(
      WebhookSignatureError,
    );
    const later = new Date(at.getTime() + 301_000);
    expect(() => verifyWebhook(payload, header, SECRET, later)).toThrow(/too old/);
  });

  it('accepts any of several v1 signatures, as during a secret rotation', () => {
    const good = signWebhook(payload, SECRET, at).split(',')[1];
    const t = Math.floor(at.getTime() / 1000);
    expect(() =>
      verifyWebhook(payload, `t=${t},v1=${'0'.repeat(64)},${good}`, SECRET, at),
    ).not.toThrow();
  });
});

describe('test mode only', () => {
  it('refuses live and malformed keys', () => {
    expect(() => assertTestModeKey(KEY)).not.toThrow();
    expect(() => assertTestModeKey('rk_test_abc123')).not.toThrow();
    expect(() => assertTestModeKey('sk_live_abc123')).toThrow(LiveBillingKeyError);
    expect(() => assertTestModeKey('')).toThrow(LiveBillingKeyError);
    expect(() => new StripeBilling({ secretKey: 'sk_live_abc123', webhookSecret: SECRET })).toThrow(
      LiveBillingKeyError,
    );
  });
});

describe('reading Stripe objects', () => {
  it('reads a subscription in the current shape and the older one', () => {
    const current = readSubscription({
      id: 'sub_1',
      customer: 'cus_1',
      status: 'past_due',
      cancel_at_period_end: true,
      metadata: { user_id: 'u1' },
      items: { data: [{ price: { id: 'price_pro' }, current_period_end: 1_790_000_000 }] },
    });
    expect(current).toEqual({
      id: 'sub_1',
      customerId: 'cus_1',
      status: 'past_due',
      priceId: 'price_pro',
      currentPeriodEnd: new Date(1_790_000_000_000),
      cancelAtPeriodEnd: true,
      userId: 'u1',
    });
    const older = readSubscription({
      id: 'sub_2',
      customer: { id: 'cus_2' },
      status: 'something_new',
      current_period_end: 1_790_000_000,
      items: { data: [{ price: 'price_free' }] },
    });
    expect(older).toMatchObject({
      customerId: 'cus_2',
      status: 'incomplete',
      priceId: 'price_free',
      currentPeriodEnd: new Date(1_790_000_000_000),
      userId: null,
    });
  });

  it('finds the subscription and user in each kind of event', () => {
    const base = { id: 'evt_1', created: 1_790_000_000 };
    expect(
      readEvent({
        ...base,
        type: 'checkout.session.completed',
        data: { object: { customer: 'cus_1', subscription: 'sub_1', client_reference_id: 'u1' } },
      }),
    ).toEqual({
      id: 'evt_1',
      type: 'checkout.session.completed',
      created: new Date(1_790_000_000_000),
      userId: 'u1',
      customerId: 'cus_1',
      subscriptionId: 'sub_1',
    });
    expect(
      readEvent({
        ...base,
        type: 'invoice.payment_failed',
        data: {
          object: {
            customer: 'cus_1',
            parent: { subscription_details: { subscription: 'sub_1' } },
          },
        },
      }).subscriptionId,
    ).toBe('sub_1');
    expect(
      readEvent({ ...base, type: 'invoice.paid', data: { object: { subscription: 'sub_9' } } })
        .subscriptionId,
    ).toBe('sub_9');
    expect(
      readEvent({
        ...base,
        type: 'customer.subscription.updated',
        data: { object: { id: 'sub_3' } },
      }).subscriptionId,
    ).toBe('sub_3');
    expect(() => readEvent({ type: 'x' })).toThrow(BillingRequestError);
  });
});

describe('StripeBilling', () => {
  function stub(respond: (url: string, init: RequestInit) => Response) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch: Fetch = async (url, init) => {
      calls.push({ url, init });
      return respond(url, init);
    };
    return { calls, stripe: new StripeBilling({ secretKey: KEY, webhookSecret: SECRET, fetch }) };
  }

  it('opens a subscription checkout for the user, reusing their customer', async () => {
    const { calls, stripe } = stub(() =>
      Response.json({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' }),
    );
    const session = await stripe.createCheckoutSession({
      userId: 'u1',
      email: 'trader@example.test',
      priceId: 'price_pro',
      successUrl: 'https://app.example.test/settings/billing?checkout=done',
      cancelUrl: 'https://app.example.test/settings/billing',
    });
    expect(session).toEqual({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' });
    expect(calls[0]?.url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    const form = new URLSearchParams(calls[0]?.init.body as string);
    expect(Object.fromEntries(form)).toEqual({
      mode: 'subscription',
      'line_items[0][price]': 'price_pro',
      'line_items[0][quantity]': '1',
      success_url: 'https://app.example.test/settings/billing?checkout=done',
      cancel_url: 'https://app.example.test/settings/billing',
      client_reference_id: 'u1',
      'metadata[user_id]': 'u1',
      'subscription_data[metadata][user_id]': 'u1',
      customer_email: 'trader@example.test',
    });

    await stripe.createCheckoutSession({
      userId: 'u1',
      email: 'trader@example.test',
      priceId: 'price_pro',
      customerId: 'cus_1',
      successUrl: 'https://a.test/s',
      cancelUrl: 'https://a.test/c',
    });
    const again = new URLSearchParams(calls[1]?.init.body as string);
    expect(again.get('customer')).toBe('cus_1');
    expect(again.has('customer_email')).toBe(false);
  });

  it('reads a subscription, and treats a missing one as gone', async () => {
    const { stripe } = stub((url) =>
      url.endsWith('/sub_1')
        ? Response.json({ id: 'sub_1', customer: 'cus_1', status: 'active', items: { data: [] } })
        : Response.json({ error: { message: 'No such subscription' } }, { status: 404 }),
    );
    expect((await stripe.getSubscription('sub_1'))?.status).toBe('active');
    expect(await stripe.getSubscription('sub_x')).toBeNull();
  });

  it('reports an outage as retryable and never repeats the key', async () => {
    const down = stub(() => new Response('', { status: 503 })).stripe;
    await expect(down.getSubscription('sub_1')).rejects.toBeInstanceOf(BillingUnavailableError);
    const unreachable = new StripeBilling({
      secretKey: KEY,
      webhookSecret: SECRET,
      fetch: async () => {
        throw new TypeError(`fetch failed for ${KEY}`);
      },
    });
    const error = await unreachable.getSubscription('sub_1').catch((e: Error) => e);
    expect(error).toBeInstanceOf(BillingUnavailableError);
    expect(String((error as Error).message)).not.toContain(KEY);
    const refused = stub(() =>
      Response.json({ error: { message: 'Invalid API Key provided' } }, { status: 401 }),
    ).stripe;
    await expect(
      refused.createPortalSession({ customerId: 'cus_1', returnUrl: 'https://a.test' }),
    ).rejects.toMatchObject({ status: 401 });
  });
});
