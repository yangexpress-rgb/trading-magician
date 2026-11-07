import { getCurrentConvention, listConventionVersions } from '@tm/db';
import { api } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

export const GET = api(async (_request, { tx }) => {
  const result = await tx(async (t) => ({
    current: (await getCurrentConvention(t)).label,
    versions: await listConventionVersions(t),
  }));
  return Response.json(result);
});
