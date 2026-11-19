import { runDetailQuery } from '@tm/contracts';
import { getRunDetail } from '@tm/db';
import { api, readQuery } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

/** The cycles and orders behind one figure on Strategies on paper (N305). */
export const GET = api<{ runtimeId: string }>(async (request, { tx }, { runtimeId }) => {
  const { kind } = readQuery(request, runDetailQuery);
  return Response.json(await tx((t) => getRunDetail(t, runtimeId, kind)));
});
