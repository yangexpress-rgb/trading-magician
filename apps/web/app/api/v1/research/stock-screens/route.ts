import { createStockScreenRequest } from '@tm/contracts';
import { requestStockScreen } from '@tm/db';
import { api, readJson } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

/** Asks the worker to screen every stock and ETF the tenant's data feed covers (ADR 0030). */
export const POST = api(async (request, { userId, tx }) => {
  const body = await readJson(request, createStockScreenRequest);
  return Response.json(await tx((t) => requestStockScreen(t, { userId, fresh: body.fresh })), {
    status: 202,
  });
});
