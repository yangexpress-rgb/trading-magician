import { performanceTimeseries } from '@tm/db';
import { api } from '@/lib/server/api';
import { readPerformanceFilter } from '@/lib/server/performance';

export const dynamic = 'force-dynamic';

export const GET = api(async (request, { tx }) => {
  const filter = readPerformanceFilter(request);
  return Response.json(await tx((t) => performanceTimeseries(t, filter)));
});
