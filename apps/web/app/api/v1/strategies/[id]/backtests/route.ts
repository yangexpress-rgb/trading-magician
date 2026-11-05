import { startBacktestRequest } from '@tm/contracts';
import { listBacktests, loadStrategyRow, startBacktest } from '@tm/db';
import { nyDate } from '@tm/domain';
import { DEMO_HISTORY_START } from '@tm/market-data';
import { api, HttpError, readJson } from '@/lib/server/api';

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
  const inputs = await readJson(request, startBacktestRequest);
  const today = nyDate(new Date().toISOString());
  if (inputs.from < DEMO_HISTORY_START) {
    throw new HttpError('bad_request', 'Some fields need attention', [
      { path: ['from'], message: `Demo history starts on ${DEMO_HISTORY_START}` },
    ]);
  }
  if (inputs.to >= today) {
    throw new HttpError('bad_request', 'Some fields need attention', [
      { path: ['to'], message: 'Choose an end date before today' },
    ]);
  }
  return Response.json(await tx((t) => startBacktest(t, userId, id, inputs)), { status: 202 });
});
