import { createPlatformRequest, type PlatformListDto } from '@tm/contracts';
import { createPlatform, listPlatforms } from '@tm/db';
import { api, readJson } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

export const GET = api(async (_request, { tx }) => {
  const body: PlatformListDto = { platforms: await tx((t) => listPlatforms(t)) };
  return Response.json(body);
});

/** Adds a platform; the worker connects it and discovers its accounts. */
export const POST = api(async (request, { userId, tx }) => {
  const input = await readJson(request, createPlatformRequest);
  return Response.json(await tx((t) => createPlatform(t, { userId, ...input })), { status: 201 });
});
