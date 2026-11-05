import { getBacktest, listBacktestTrades } from '@tm/db';
import { api } from '@/lib/server/api';
import { tradesCsv } from '@/lib/server/backtest-csv';

export const dynamic = 'force-dynamic';

/** The trade list as CSV, one row per leg (§14.2). */
export const GET = api<{ runId: string }>(async (_request, { tx }, { runId }) => {
  const { run, trades } = await tx(async (t) => ({
    run: await getBacktest(t, runId),
    trades: await listBacktestTrades(t, runId),
  }));
  return new Response(tradesCsv(run, trades), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="backtest-${run.id}.csv"`,
      'cache-control': 'no-store',
    },
  });
});
