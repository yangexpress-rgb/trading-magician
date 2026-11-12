import {
  activeOptionsFeed,
  listTenantInstruments,
  loadRouting,
  sharedFeedsInUse,
  usableFundamentalsFeed,
  withTenant,
} from '@tm/db';
import {
  CHART_INTERVALS,
  CHART_RANGES,
  chartIntervalAllowed,
  defaultChartInterval,
  isProviderId,
  nyDate,
  providerCoversVenue,
  PROVIDERS,
  type ChartInterval,
  type ChartRange,
} from '@tm/domain';
import { PageHeader } from '@tm/ui';
import type { Metadata } from 'next';
import { ResearchNav } from '@/components/research/research-nav';
import { ResearchWorkspace } from '@/components/research/research-workspace';
import { MAX_COMPARE } from '@/lib/chart-history';
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
  const { instruments, canSearchMarket, companyFeed, optionsFeed } = await withTenant(
    appDb(),
    tenant,
    async (tx) => ({
      instruments: await listTenantInstruments(tx),
      // A real price feed, such as Alpaca, can search every US stock (ADR 0029).
      // Without a price feed of their own, the admin's shared ones search for them (N237).
      canSearchMarket: [
        ...(await loadRouting(tx)).feeds.values(),
        ...(await sharedFeedsInUse(tx, 'prices')).map((f) => ({ ...f, isActive: true })),
      ].some(
        (f) =>
          f.isActive &&
          providerCoversVenue(f.provider, 'US') &&
          isProviderId(f.provider) &&
          (PROVIDERS[f.provider].assetClasses as readonly string[]).includes('stock'),
      ),
      // Company financials come from a company data feed, such as SEC EDGAR (ADR 0031).
      companyFeed: (await usableFundamentalsFeed(tx))?.name ?? null,
      // Options data comes from the keyless CBOE options feed (ADR 0047, 0048).
      optionsFeed: (await activeOptionsFeed(tx))?.name ?? null,
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
  // A chart can end on an earlier date (N196) and compare other symbols (N198).
  const rawDate = one(params.date);
  const end =
    rawDate && /^\d{4}-\d{2}-\d{2}$/.test(rawDate) && rawDate < nyDate(new Date()) ? rawDate : null;
  const compare = [
    ...new Set(
      (one(params.compare) ?? '').split(',').filter((id) => instruments.some((i) => i.id === id)),
    ),
  ].slice(0, MAX_COMPARE);
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
        description="Pick a stock or ETF and study its price history, options and company financials."
      />
      <ResearchNav />
      <ResearchWorkspace
        instruments={instruments}
        canSearchMarket={canSearchMarket}
        companyFeed={companyFeed}
        optionsFeed={optionsFeed}
        initial={{
          instrumentId,
          range,
          interval,
          // Candles unless the address asks for a line (N203).
          style: one(params.style) === 'line' ? 'line' : 'candles',
          end,
          compare,
        }}
      />
    </>
  );
}
