import { ensureWatchList, loadWatchQuotes, touchWatchView } from '@tm/db';
import { api } from '@/lib/server/api';
import { buildWatchList } from '@/lib/watch-list';

export const dynamic = 'force-dynamic';

/**
 * The person's watch list with the latest prices (N292, ADR 0101). The page
 * asks every few seconds; each ask also tells the worker the list is open.
 */
export const GET = api(async (_request, { userId, tx }) => {
  const body = await tx(async (t) => {
    const { groups } = await ensureWatchList(t, userId);
    await touchWatchView(t, userId);
    const symbols = groups.flatMap((g) => g.items.map((i) => i.symbol));
    return buildWatchList(groups, await loadWatchQuotes(t, symbols), new Date());
  });
  return Response.json(body, { headers: { 'cache-control': 'no-store' } });
});
