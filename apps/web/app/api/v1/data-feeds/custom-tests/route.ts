import { customFeedTestRequest } from '@tm/contracts';
import { requestCustomFeedTest } from '@tm/db';
import { api, readJson } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

/**
 * Asks the worker to test a custom REST feed's settings with one symbol
 * (ADR 0041). The browser never calls the provider; it polls the result.
 */
export const POST = api(async (request, { userId, tx }) => {
  const input = await readJson(request, customFeedTestRequest);
  return Response.json(await tx((t) => requestCustomFeedTest(t, { userId, ...input })), {
    status: 202,
  });
});
