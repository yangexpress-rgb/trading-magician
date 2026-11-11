import { startBacktestRequest } from '@tm/contracts';
import { listBacktests, loadStrategyRow, startBacktest } from '@tm/db';
import { addDays, nyDate } from '@tm/domain';
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
  const asked = await readJson(request, startBacktestRequest);
  const today = nyDate(new Date().toISOString());
  if (asked.to > today) {
    throw new HttpError('bad_request', 'Some fields need attention', [
      { path: ['to'], message: 'Choose today or an earlier date' },
    ]);
  }
  // Today's bars are still forming (N229): a run that ends today reads up to yesterday's close.
  const inputs =
    asked.to === today
      ? {
          ...asked,
          to: addDays(today, -1),
          from: asked.from > addDays(today, -1) ? addDays(today, -1) : asked.from,
        }
      : asked;
  if (inputs.from < DEMO_HISTORY_START) {
    throw new HttpError('bad_request', 'Some fields need attention', [
      { path: ['from'], message: `Back tests start no earlier than ${DEMO_HISTORY_START}` },
    ]);
  }
  return Response.json(await tx((t) => startBacktest(t, userId, id, inputs)), { status: 202 });
});
