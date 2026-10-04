import { duplicateStrategyRequest } from '@tm/contracts';
import { duplicateStrategy } from '@tm/db';
import { api, readJson } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

export const POST = api<{ id: string }>(async (request, { tx, userId }, { id }) => {
  const body = await readJson(request, duplicateStrategyRequest);
  const copy = await tx((t) => duplicateStrategy(t, userId, id, body));
  return Response.json(copy, {
    status: 201,
    headers: { location: `/api/v1/strategies/${copy.id}` },
  });
});
