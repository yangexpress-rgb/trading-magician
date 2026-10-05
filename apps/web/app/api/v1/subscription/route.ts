import type { SubscriptionDto } from '@tm/contracts';
import { getSubscription } from '@tm/db';
import { api } from '@/lib/server/api';
import { billingProvider } from '@/lib/server/billing';

export const dynamic = 'force-dynamic';

export const GET = api(async (_request, { tx }) => {
  const s = await tx(getSubscription);
  const body: SubscriptionDto = {
    planCode: s.planCode,
    planName: s.planName,
    status: s.status,
    currentPeriodEnd: s.currentPeriodEnd?.toISOString() ?? null,
    cancelAtPeriodEnd: s.cancelAtPeriodEnd,
    graceEndsAt: s.graceEndsAt?.toISOString() ?? null,
    canManage: s.customerId !== null,
    billingAvailable: billingProvider() !== undefined,
  };
  return Response.json(body);
});
