import { rowVersionRequest } from '@tm/contracts';
import { getStrategy, publishVersion } from '@tm/db';
import { api, readJson } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

type Params = { id: string };

export const GET = api<Params>(async (_request, { tx }, { id }) =>
  Response.json((await tx((t) => getStrategy(t, id))).versions),
);

/** Publishes the draft as an immutable version; 200 when it equals the current one. */
export const POST = api<Params>(async (request, { tx, userId }, { id }) => {
  const body = await readJson(request, rowVersionRequest);
  const result = await tx((t) => publishVersion(t, userId, id, body));
  return Response.json(result, { status: result.created ? 201 : 200 });
});
