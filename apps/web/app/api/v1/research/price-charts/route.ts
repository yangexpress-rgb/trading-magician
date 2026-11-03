import { createPriceChartRequest } from '@tm/contracts';
import { requestPriceChart } from '@tm/db';
import { api, readJson } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

/** Asks the worker for an instrument's bars through the tenant's data feed (ADR 0029). */
export const POST = api(async (request, { userId, tx }) => {
  const body = await readJson(request, createPriceChartRequest);
  return Response.json(await tx((t) => requestPriceChart(t, { userId, ...body })), {
    status: 202,
  });
});
