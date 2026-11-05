import { listOrdersQuery } from '@tm/contracts';
import { listOrders } from '@tm/db';
import { api, readQuery } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

export const GET = api(async (request, { tx }) => {
  const { tz, ...filters } = readQuery(request, listOrdersQuery);
  return Response.json(await tx((t) => listOrders(t, { ...filters, timeZone: tz })));
});
