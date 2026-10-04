import { closePositionsRequest } from '@tm/contracts';
import { closePositions } from '@tm/db';
import { api, readJson } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

/** Market orders, marked as the person's, that close what a stopped strategy holds (§14.3). */
export const POST = api(async (request, { tx, userId }) => {
  const body = await readJson(request, closePositionsRequest);
  return Response.json(await tx((t) => closePositions(t, userId, body)));
});
