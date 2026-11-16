import type { YearRangeDto } from '@tm/contracts';
import { loadPriceRange } from '@tm/db';
import { api } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A stock's stored 52-week low and high (N290), for Price charts. */
export const GET = api<{ instrumentId: string }>(async (_request, { tx }, { instrumentId }) => {
  const body: YearRangeDto = {
    instrumentId,
    range: UUID.test(instrumentId) ? await tx((t) => loadPriceRange(t, instrumentId)) : null,
  };
  return Response.json(body);
});
