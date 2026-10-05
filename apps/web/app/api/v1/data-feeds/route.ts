import { createFeedRequest, type FeedListDto } from '@tm/contracts';
import { createFeed, listFeeds, listRoutes } from '@tm/db';
import { api, readJson } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

export const GET = api(async (_request, { tx }) => {
  const body: FeedListDto = await tx(async (t) => ({
    feeds: await listFeeds(t),
    routes: await listRoutes(t),
  }));
  return Response.json(body);
});

export const POST = api(async (request, { userId, tx }) => {
  const input = await readJson(request, createFeedRequest);
  return Response.json(await tx((t) => createFeed(t, { userId, ...input })), { status: 201 });
});
