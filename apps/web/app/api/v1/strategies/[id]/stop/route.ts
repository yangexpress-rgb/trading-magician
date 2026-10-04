import { stopStrategyRequest } from '@tm/contracts';
import { stopStrategy } from '@tm/db';
import { api, readJson } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

export const POST = api<{ id: string }>(async (request, { tx, userId }, { id }) => {
  const body = await readJson(request, stopStrategyRequest);
  return Response.json(await tx((t) => stopStrategy(t, userId, id, body)));
});
