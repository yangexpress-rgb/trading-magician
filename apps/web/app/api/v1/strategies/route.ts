import { createStrategyRequest, listStrategiesQuery } from '@tm/contracts';
import { createStrategy, listStrategies } from '@tm/db';
import { api, readJson, readQuery } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

const DAY_MS = 86_400_000;

export const GET = api(async (request, { tx }) => {
  const q = readQuery(request, listStrategiesQuery);
  const result = await tx((t) =>
    listStrategies(t, {
      search: q.q,
      statuses: q.status,
      instrumentId: q.instrumentId,
      // Whole UTC days; `updatedTo` is inclusive.
      updatedFrom: q.updatedFrom ? new Date(`${q.updatedFrom}T00:00:00Z`) : undefined,
      updatedTo: q.updatedTo
        ? new Date(Date.parse(`${q.updatedTo}T00:00:00Z`) + DAY_MS)
        : undefined,
      archived: q.archived,
      shared: q.shared,
      sort: q.sort,
      direction: q.direction,
      limit: q.limit,
      offset: q.offset,
    }),
  );
  return Response.json(result);
});

export const POST = api(async (request, { tx, userId }) => {
  const body = await readJson(request, createStrategyRequest);
  const strategy = await tx((t) => createStrategy(t, userId, body));
  return Response.json(strategy, {
    status: 201,
    headers: { location: `/api/v1/strategies/${strategy.id}` },
  });
});
