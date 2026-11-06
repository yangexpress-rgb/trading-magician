import { demoDataEnabled, loadRouting, withTenant } from '@tm/db';
import { providerCoversVenue } from '@tm/domain';
import { PageHeader } from '@tm/ui';
import type { Metadata } from 'next';
import { ResearchNav } from '@/components/research/research-nav';
import { StockScreener } from '@/components/research/stock-screener';
import { appDb } from '@/lib/server/db';
import { requireTenant } from '@/lib/server/session';

export const metadata: Metadata = { title: 'Stock screener · Quantitative Research' };

/** The stock screener (Design v1.0 §11; ADR 0030): every stock the data feed covers, filtered and sorted. */
export default async function ScreenerPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const tenant = await requireTenant();
  const canScreenMarket = await withTenant(appDb(), tenant, async (tx) =>
    [...(await loadRouting(tx)).feeds.values()].some(
      (f) => f.isActive && providerCoversVenue(f.provider, 'US'),
    ),
  );
  const initial = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    const value = Array.isArray(v) ? v[0] : v;
    if (value !== undefined) initial.set(k, value);
  }
  return (
    <>
      <PageHeader
        title="Quantitative Research"
        description="Screen every stock and ETF your data feed covers by price, change, volume and company figures."
      />
      <ResearchNav />
      <StockScreener
        canScreenMarket={canScreenMarket}
        demoData={demoDataEnabled()}
        initialQuery={initial.toString()}
      />
    </>
  );
}
