import { startBacktestRequest } from '@tm/contracts';
import { listBacktests, loadStrategyRow } from '@tm/db';
import { api, readJson } from '@/lib/server/api';
import { queueBacktest } from '@/lib/server/backtest-start';

export const dynamic = 'force-dynamic';

type Params = { id: string };

/** The strategy's back tests, newest first. */
export const GET = api<Params>(async (_request, { tx }, { id }) =>
  Response.json(
    await tx(async (t) => {
      await loadStrategyRow(t, id);
      return { runs: await listBacktests(t, id) };
    }),
  ),
);

/** Queues a back test of the current draft (§7, §14.2). The worker picks it up. */
export const POST = api<Params>(async (request, { tx, userId }, { id }) => {
  const asked = await readJson(request, startBacktestRequest);
  return Response.json(await tx((t) => queueBacktest(t, userId, id, asked)), { status: 202 });
});
