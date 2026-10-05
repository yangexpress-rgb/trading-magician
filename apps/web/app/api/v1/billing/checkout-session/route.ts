import { checkoutSessionRequest, type BillingRedirectDto } from '@tm/contracts';
import { getSubscription, listOfferedPlans, planPrices } from '@tm/db';
import { api, HttpError, readJson } from '@/lib/server/api';
import { billingProvider, fakePrices } from '@/lib/server/billing';
import { serverEnv } from '@/lib/server/env';

export const dynamic = 'force-dynamic';

const PAYING = new Set(['active', 'trialing', 'past_due']);

/** Starts checkout for a paid plan on the provider's hosted page (§14; ADR 0023). */
export const POST = api(async (request, { tx, userId, email }) => {
  const { planCode } = await readJson(request, checkoutSessionRequest);
  const provider = billingProvider();
  if (!provider) throw new HttpError('unavailable', 'Paying for a plan is not set up yet');
  const { priceId, customerId } = await tx(async (t) => {
    const plan = (await listOfferedPlans(t)).find((p) => p.code === planCode);
    const price = (await planPrices(t, fakePrices())).find((p) => p.code === planCode)?.priceId;
    if (!plan || plan.priceMinor === 0 || !price) {
      throw new HttpError('bad_request', 'That plan cannot be bought');
    }
    const current = await getSubscription(t);
    if (current.status && PAYING.has(current.status)) {
      throw new HttpError(
        'conflict',
        'You already have a subscription. Use Manage billing to change it.',
      );
    }
    return { priceId: price, customerId: current.customerId };
  });
  const base = serverEnv().APP_URL;
  const session = await provider.createCheckoutSession({
    userId,
    email,
    priceId,
    customerId,
    successUrl: `${base}/settings/billing?checkout=done`,
    cancelUrl: `${base}/settings/billing?checkout=canceled`,
  });
  const body: BillingRedirectDto = { url: session.url };
  return Response.json(body, { status: 201 });
});
