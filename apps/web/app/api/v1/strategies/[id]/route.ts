import { rowVersionRequest, updateStrategyRequest } from '@tm/contracts';
import { deleteStrategy, getStrategy, updateStrategy } from '@tm/db';
import { api, readJson } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

type Params = { id: string };

export const GET = api<Params>(async (_request, { tx }, { id }) =>
  Response.json(await tx((t) => getStrategy(t, id))),
);

export const PATCH = api<Params>(async (request, { tx, userId }, { id }) => {
  const body = await readJson(request, updateStrategyRequest);
  return Response.json(await tx((t) => updateStrategy(t, userId, id, body)));
});

export const DELETE = api<Params>(async (request, { tx, userId }, { id }) => {
  const body = await readJson(request, rowVersionRequest);
  await tx((t) => deleteStrategy(t, userId, id, body));
  return new Response(null, { status: 204 });
});
