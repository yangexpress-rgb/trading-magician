import { startStrategyRequest } from '@tm/contracts';
import { startStrategy } from '@tm/db';
import { api, readJson } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

/** Starts the strategy on paper. Live trading does not exist in this build (ADR 0002). */
export const POST = api<{ id: string }>(async (request, { tx, userId }, { id }) => {
  const body = await readJson(request, startStrategyRequest);
  return Response.json(
    await tx((t) =>
      startStrategy(t, userId, id, {
        rowVersion: body.rowVersion,
        confirmed: body.confirmed,
        acknowledgedWarnings: body.acknowledgedWarnings,
      }),
    ),
  );
});
