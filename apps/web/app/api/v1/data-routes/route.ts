import { createRouteRequest } from '@tm/contracts';
import { createRoute } from '@tm/db';
import { api, readJson } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

export const POST = api(async (request, { userId, tx }) => {
  const input = await readJson(request, createRouteRequest);
  return Response.json(await tx((t) => createRoute(t, { userId, ...input })), { status: 201 });
});
