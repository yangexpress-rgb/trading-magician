import { createInstrumentLookupRequest } from '@tm/contracts';
import { requestInstrumentLookup } from '@tm/db';
import { api, readJson } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

/** Asks the worker to find a US stock or ETF through the tenant's data feed (ADR 0017). */
export const POST = api(async (request, { userId, tx }) => {
  const { symbol } = await readJson(request, createInstrumentLookupRequest);
  return Response.json(await tx((t) => requestInstrumentLookup(t, { userId, symbol })), {
    status: 202,
  });
});
