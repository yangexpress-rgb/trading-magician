import { updatePlatformRequest } from '@tm/contracts';
import { deletePlatform, updatePlatform } from '@tm/db';
import { api, readJson } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

export const PATCH = api<{ brokerId: string }>(async (request, { userId, tx }, { brokerId }) => {
  const input = await readJson(request, updatePlatformRequest);
  return Response.json(await tx((t) => updatePlatform(t, { userId, id: brokerId, ...input })));
});

export const DELETE = api<{ brokerId: string }>(async (_request, { userId, tx }, { brokerId }) => {
  await tx((t) => deletePlatform(t, { userId, id: brokerId }));
  return new Response(null, { status: 204 });
});
