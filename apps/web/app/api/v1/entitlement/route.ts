import { loadEntitlement, loadUsage } from '@tm/db';
import type { EntitlementDto } from '@tm/contracts';
import { api } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

export const GET = api(async (_request, { tx }) => {
  const body: EntitlementDto = await tx(async (t) => ({
    ...(await loadEntitlement(t)),
    usage: await loadUsage(t),
  }));
  return Response.json(body);
});
