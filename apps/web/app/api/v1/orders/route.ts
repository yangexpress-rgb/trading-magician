import { listOrdersQuery } from '@tm/contracts';
import { listOrders, touchOrderPriceView } from '@tm/db';
import { api, readQuery } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

export const GET = api(async (request, { tx, userId }) => {
  const { tz, ...filters } = readQuery(request, listOrdersQuery);
  return Response.json(
    await tx(async (t) => {
      // Orders is open: keep its instruments priced for Last price (N330).
      await touchOrderPriceView(t, userId);
      return listOrders(t, { ...filters, timeZone: tz });
    }),
  );
});
