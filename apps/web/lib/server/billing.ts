import 'server-only';
import {
  BillingUnavailableError,
  StripeBilling,
  WebhookSignatureError,
  type BillingProvider,
  type ProviderSubscription,
} from '@tm/billing';
import { FakeStripe } from '@tm/billing/testing';
import {
  applySubscription,
  billingUserFor,
  planPrices,
  recordBillingEvent,
  withTenant,
} from '@tm/db';
import { appDb } from './db';
import { serverEnv } from './env';

/**
 * Billing for the web app (ADR 0023): the provider, and the webhook handler.
 * Stripe in test mode when its keys are set; an in-process stand-in when
 * BILLING_FAKE is on (tests only); otherwise billing is not available.
 */

const FAKE_WEBHOOK_SECRET = 'whsec_fake_local_only';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const g = globalThis as { __tmFakeStripe?: FakeStripe };

export function fakeStripe(): FakeStripe | undefined {
  const env = serverEnv();
  if (!env.BILLING_FAKE) return undefined;
  return (g.__tmFakeStripe ??= new FakeStripe({
    webhookSecret: FAKE_WEBHOOK_SECRET,
    pagesUrl: `${env.APP_URL}/billing-fake`,
    deliver: async (payload, signature) => {
      const res = await fetch(`${env.APP_URL}/api/v1/webhooks/billing`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'stripe-signature': signature },
        body: payload,
      });
      if (!res.ok) throw new Error(`The webhook answered ${res.status}`);
    },
  }));
}

let stripe: StripeBilling | undefined;

export function billingProvider(): BillingProvider | undefined {
  const fake = fakeStripe();
  if (fake) return fake;
  const env = serverEnv();
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) return undefined;
  return (stripe ??= new StripeBilling({
    secretKey: env.STRIPE_SECRET_KEY,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET,
  }));
}

/** Whether plan prices are the stand-in's made-up ones. */
export const fakePrices = () => serverEnv().BILLING_FAKE;

export type WebhookOutcome = 'applied' | 'duplicate' | 'ignored';

export class WebhookRejected extends Error {
  constructor(
    readonly status: 400 | 503,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Handles one webhook. The event says only that something changed; the
 * subscription is read back from the provider and applied, so events may come
 * late, twice or out of order. Unknown events are acknowledged and ignored.
 */
export async function handleBillingWebhook(
  payload: string,
  signature: string | null,
): Promise<WebhookOutcome> {
  const provider = billingProvider();
  if (!provider) throw new WebhookRejected(503, 'Billing is not set up');
  let event;
  try {
    event = provider.parseWebhook(payload, signature);
  } catch (error) {
    if (error instanceof WebhookSignatureError) throw new WebhookRejected(400, error.message);
    throw new WebhookRejected(400, 'The webhook could not be read');
  }
  if (!event.subscriptionId) return 'ignored';

  let subscription: ProviderSubscription | null;
  try {
    subscription = await provider.getSubscription(event.subscriptionId);
  } catch (error) {
    if (error instanceof BillingUnavailableError) throw new WebhookRejected(503, error.message);
    throw error;
  }
  const userId =
    [event.userId, subscription?.userId].find((id) => id && UUID.test(id)) ??
    (await billingUserFor(appDb(), {
      customerId: event.customerId,
      subscriptionId: event.subscriptionId,
    }));
  if (!userId || !subscription) return 'ignored';

  return withTenant(appDb(), { userId }, async (tx) => {
    if (!(await recordBillingEvent(tx, { id: event.id, type: event.type, userId }))) {
      return 'duplicate';
    }
    await applySubscription(tx, {
      userId,
      state: {
        customerId: subscription.customerId,
        subscriptionId: subscription.id,
        status: subscription.status,
        priceId: subscription.priceId,
        currentPeriodEnd: subscription.currentPeriodEnd,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      },
      prices: await planPrices(tx, fakePrices()),
      reason: event.type,
    });
    return 'applied';
  });
}
