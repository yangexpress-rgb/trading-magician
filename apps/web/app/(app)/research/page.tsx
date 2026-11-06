import { activeFundamentalsFeed, listTenantInstruments, loadRouting, withTenant } from '@tm/db';
import {
  CHART_INTERVALS,
  CHART_RANGES,
  chartIntervalAllowed,
  defaultChartInterval,
  isProviderId,
  providerCoversVenue,
  PROVIDERS,
  type ChartInterval,
  type ChartRange,
} from '@tm/domain';
import { PageHeader } from '@tm/ui';
import type { Metadata } from 'next';
import { ResearchNav } from '@/components/research/research-nav';
import { ResearchWorkspace } from '@/components/research/research-workspace';
import { appDb } from '@/lib/server/db';
import { requireTenant } from '@/lib/server/session';

export const metadata: Metadata = { title: 'Quantitative Research' };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Quantitative Research (Design v1.0 §11; ADR 0029): pick a stock and chart its prices. */
export default async function ResearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const tenant = await requireTenant();
  const { instruments, canSearchMarket, companyFeed } = await withTenant(
    appDb(),
    tenant,
    async (tx) => ({
      instruments: await listTenantInstruments(tx),
      // A real price feed, such as Alpaca, can search every US stock (ADR 0029).
      canSearchMarket: [...(await loadRouting(tx)).feeds.values()].some(
        (f) =>
          f.isActive &&
          providerCoversVenue(f.provider, 'US') &&
          isProviderId(f.provider) &&
          (PROVIDERS[f.provider].assetClasses as readonly string[]).includes('stock'),
      ),
      // Company financials come from a company data feed, such as SEC EDGAR (ADR 0031).
      companyFeed: (await activeFundamentalsFeed(tx))?.name ?? null,
    }),
  );
  const wanted = one(params.instrument);
  const rawRange = one(params.range) as ChartRange;
  const rawInterval = one(params.interval) as ChartInterval;
  const range = CHART_RANGES.includes(rawRange) ? rawRange : '1d';
  const interval =
    CHART_INTERVALS.includes(rawInterval) && chartIntervalAllowed(range, rawInterval)
      ? rawInterval
      : defaultChartInterval(range);
  const instrumentId =
    instruments.find((i) => i.id === wanted)?.id ??
    // With demo data on (tests only, ADR 0039), start on the broad-market demo ETF.
    instruments.find((i) => i.symbol === 'DEMO-IDX')?.id ??
    instruments[0]?.id ??
    null;

  return (
    <>
      <PageHeader
        title="Quantitative Research"
        description="Pick a stock or ETF and study its price history and company financials."
      />
      <ResearchNav />
      <ResearchWorkspace
        instruments={instruments}
        canSearchMarket={canSearchMarket}
        companyFeed={companyFeed}
        initial={{
          instrumentId,
          range,
          interval,
          style: one(params.style) === 'candles' ? 'candles' : 'line',
        }}
      />
    </>
  );
}
