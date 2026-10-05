import type { BillingRedirectDto } from '@tm/contracts';
import { getSubscription } from '@tm/db';
import { api, HttpError } from '@/lib/server/api';
import { billingProvider } from '@/lib/server/billing';
import { serverEnv } from '@/lib/server/env';

export const dynamic = 'force-dynamic';

/** Opens the provider's billing portal: card, invoices, plan changes, cancelling. */
export const POST = api(async (_request, { tx }) => {
  const provider = billingProvider();
  if (!provider) throw new HttpError('unavailable', 'Billing is not set up yet');
  const { customerId } = await tx(getSubscription);
  if (!customerId) throw new HttpError('invalid_state', 'There is no subscription to manage yet');
  const session = await provider.createPortalSession({
    customerId,
    returnUrl: `${serverEnv().APP_URL}/settings/billing`,
  });
  const body: BillingRedirectDto = { url: session.url };
  return Response.json(body, { status: 201 });
});
