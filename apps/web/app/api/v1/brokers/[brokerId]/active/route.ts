import { setPlatformActiveRequest } from '@tm/contracts';
import { setPlatformActive } from '@tm/db';
import { api, readJson } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

export const POST = api<{ brokerId: string }>(async (request, { userId, tx }, { brokerId }) => {
  const input = await readJson(request, setPlatformActiveRequest);
  return Response.json(await tx((t) => setPlatformActive(t, { userId, id: brokerId, ...input })));
});
