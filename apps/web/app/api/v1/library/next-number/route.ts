import { nextNumberQuery } from '@tm/contracts';
import { previewRegistrationNumber } from '@tm/db';
import { api, readQuery } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

/** The number a registration would get if saved now. Reserves nothing. */
export const GET = api(async (request, { tx }) => {
  const q = readQuery(request, nextNumberQuery);
  const result = await tx((t) =>
    previewRegistrationNumber(t, {
      recordType: q.recordType,
      timeframe: q.timeframe,
      assetClass: q.asset,
    }),
  );
  return Response.json(result, { headers: { 'cache-control': 'no-store' } });
});
