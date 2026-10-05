import { updateFeedRequest } from '@tm/contracts';
import { deleteFeed, updateFeed } from '@tm/db';
import { api, readJson } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

export const PATCH = api<{ feedId: string }>(async (request, { userId, tx }, { feedId }) => {
  const input = await readJson(request, updateFeedRequest);
  return Response.json(await tx((t) => updateFeed(t, { userId, id: feedId, ...input })));
});

export const DELETE = api<{ feedId: string }>(async (_request, { userId, tx }, { feedId }) => {
  await tx((t) => deleteFeed(t, { userId, id: feedId }));
  return new Response(null, { status: 204 });
});
