import { ensureWatchList, loadWatchQuotes, touchWatchView, withTenant } from '@tm/db';
import { PageHeader } from '@tm/ui';
import type { Metadata } from 'next';
import { ResearchNav } from '@/components/research/research-nav';
import { WatchList } from '@/components/research/watch-list';
import { appDb } from '@/lib/server/db';
import { hasMarketSearch } from '@/lib/server/market-search';
import { requireTenant } from '@/lib/server/session';
import { buildWatchList } from '@/lib/watch-list';

export const metadata: Metadata = { title: 'Watch list' };
export const dynamic = 'force-dynamic';

/** Research › Watch list (N292, ADR 0101): live prices of the symbols a person follows. */
export default async function WatchListPage() {
  const tenant = await requireTenant();
  const { list, canSearchMarket } = await withTenant(appDb(), tenant, async (tx) => {
    const { groups } = await ensureWatchList(tx, tenant.userId);
    await touchWatchView(tx, tenant.userId, 0);
    const symbols = groups.flatMap((g) => g.items.map((i) => i.symbol));
    return {
      list: buildWatchList(groups, await loadWatchQuotes(tx, symbols), new Date()),
      canSearchMarket: await hasMarketSearch(tx),
    };
  });
  return (
    <>
      <PageHeader
        title="Quantitative Research"
        description="Follow the stocks, ETFs and indices you care about, with prices that update as they trade."
      />
      <ResearchNav />
      <WatchList initial={list} canSearchMarket={canSearchMarket} />
    </>
  );
}
