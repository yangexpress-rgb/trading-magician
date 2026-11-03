import { listTenantInstruments, withTenant } from '@tm/db';
import {
  CHART_INTERVALS,
  CHART_RANGES,
  chartIntervalAllowed,
  type ChartInterval,
  type ChartRange,
} from '@tm/domain';
import { PageHeader } from '@tm/ui';
import type { Metadata } from 'next';
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
  const instruments = await withTenant(appDb(), tenant, (tx) => listTenantInstruments(tx));
  const wanted = one(params.instrument);
  const rawRange = one(params.range) as ChartRange;
  const rawInterval = one(params.interval) as ChartInterval;
  const range = CHART_RANGES.includes(rawRange) ? rawRange : '1y';
  const interval =
    CHART_INTERVALS.includes(rawInterval) && chartIntervalAllowed(range, rawInterval)
      ? rawInterval
      : '1d';
  const instrumentId =
    instruments.find((i) => i.id === wanted)?.id ??
    // Start on the broad-market demo ETF, so the page never opens empty.
    instruments.find((i) => i.symbol === 'DEMO-IDX')?.id ??
    instruments[0]?.id ??
    null;

  return (
    <>
      <PageHeader
        title="Quantitative Research"
        description="Pick a stock or ETF and study its price history."
      />
      <ResearchWorkspace
        instruments={instruments}
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
