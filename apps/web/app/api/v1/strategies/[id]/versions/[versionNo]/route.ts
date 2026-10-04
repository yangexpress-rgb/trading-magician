import { getStrategyVersion } from '@tm/db';
import { api, HttpError } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

type Params = { id: string; versionNo: string };

export const GET = api<Params>(async (_request, { tx }, { id, versionNo }) => {
  const n = Number(versionNo);
  if (!Number.isInteger(n) || n < 1) throw new HttpError('not_found', 'Version not found');
  return Response.json(await tx((t) => getStrategyVersion(t, id, n)));
});
