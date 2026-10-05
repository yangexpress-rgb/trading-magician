import { setFeedActiveRequest } from '@tm/contracts';
import { setFeedActive } from '@tm/db';
import { api, readJson } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

export const POST = api<{ feedId: string }>(async (request, { userId, tx }, { feedId }) => {
  const input = await readJson(request, setFeedActiveRequest);
  return Response.json(await tx((t) => setFeedActive(t, { userId, id: feedId, ...input })));
});
