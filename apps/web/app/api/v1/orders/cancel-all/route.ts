import { cancelAllRequest } from '@tm/contracts';
import { cancelWorkingOrders } from '@tm/db';
import { api, readJson } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

/** The separately confirmed cancel-all that goes with the kill switch (§8.1). */
export const POST = api(async (request, { tx, userId }) => {
  await readJson(request, cancelAllRequest);
  const requested = await tx((t) =>
    cancelWorkingOrders(t, userId, { reason: 'Canceled with Cancel all orders' }),
  );
  return Response.json({ requested });
});
