import { createFeedRequest, type FeedListDto } from '@tm/contracts';
import {
  adminFeedSharing,
  createFeed,
  hasOwnFeed,
  isPlatformAdmin,
  listFeeds,
  listRoutes,
  sharedFeeds,
  type SharedFeedKind,
} from '@tm/db';
import { api, readJson } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

export const GET = api(async (_request, { tx }) => {
  const body: FeedListDto = await tx(async (t) => {
    // The admin's feeds of each kind this person has none of (N237, ADR 0084).
    const own = new Map<SharedFeedKind, boolean>();
    for (const kind of ['prices', 'company', 'options'] as const)
      own.set(kind, await hasOwnFeed(t, kind));
    const admin = await isPlatformAdmin(t);
    return {
      feeds: await listFeeds(t),
      routes: await listRoutes(t),
      shared: admin
        ? []
        : (await sharedFeeds(t))
            .filter((f) => !own.get(f.kind))
            .map((f) => ({ name: f.name, provider: f.provider, kind: f.kind })),
      sharing: admin ? await adminFeedSharing(t) : null,
    };
  });
  return Response.json(body);
});

export const POST = api(async (request, { userId, tx }) => {
  const input = await readJson(request, createFeedRequest);
  return Response.json(await tx((t) => createFeed(t, { userId, ...input })), { status: 201 });
});
