import { createOptionChainRequest } from '@tm/contracts';
import { requestLiveChain } from '@tm/db';
import { api, readJson } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

/** Asks the worker for a symbol's live option chain, unless one is fresh (ADR 0048). */
export const POST = api(async (request, { tx }) => {
  const body = await readJson(request, createOptionChainRequest);
  return Response.json(await tx((t) => requestLiveChain(t, body.symbol)), { status: 202 });
});
