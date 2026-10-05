import { updateRouteRequest } from '@tm/contracts';
import { deleteRoute, updateRoute } from '@tm/db';
import { api, readJson } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

export const PATCH = api<{ routeId: string }>(async (request, { userId, tx }, { routeId }) => {
  const input = await readJson(request, updateRouteRequest);
  return Response.json(await tx((t) => updateRoute(t, { userId, id: routeId, ...input })));
});

export const DELETE = api<{ routeId: string }>(async (_request, { userId, tx }, { routeId }) => {
  await tx((t) => deleteRoute(t, { userId, id: routeId }));
  return new Response(null, { status: 204 });
});
