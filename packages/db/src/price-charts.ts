import { chartIntervalAllowed, chartWindow, type ChartInterval, type ChartRange } from '@tm/domain';
import { and, desc, eq, gt, sql } from 'drizzle-orm';
import type { Database, Transaction } from './client';
import { IntegrationError } from './feeds';
import { listTenantInstruments, type InstrumentOptionRow } from './instruments';
import { instruments, priceCharts } from './schema';

/**
 * Price charts for Quantitative Research (ADR 0029). Bars come through the
 * tenant's bars route, which only the worker can open, so the web app queues a
 * chart and polls it; the worker stores the bars on the row.
 */

export type PriceChartStatus = 'pending' | 'ready' | 'failed';

/** `[startMs, open, high, low, close, volume]`. */
export type ChartBarTuple = [number, number, number, number, number, number];

export interface PriceChartSummary {
  id: string;
  instrument: InstrumentOptionRow;
  interval: ChartInterval;
  range: ChartRange;
  from: string;
  to: string;
  status: PriceChartStatus;
  message: string | null;
  source: string | null;
  warnings: string[];
  bars: ChartBarTuple[] | null;
  createdAt: string;
}

const MAX_PENDING = 5;
/** A ready chart this recent is shown again instead of asking the feed. */
export const CHART_REUSE_SECONDS = 300;

export async function requestPriceChart(
  tx: Transaction,
  input: {
    userId: string;
    instrumentId: string;
    interval: ChartInterval;
    range: ChartRange;
    now?: Date;
  },
): Promise<PriceChartSummary> {
  if (!chartIntervalAllowed(input.range, input.interval)) {
    throw new IntegrationError(
      'bad_request',
      '5-minute bars go back up to a week and hourly bars up to 3 months; a day has 5-minute or hourly bars.',
    );
  }
  // Only instruments the tenant can pick: demo ones, its lookups, its strategies'.
  const allowed = await listTenantInstruments(tx);
  if (!allowed.some((i) => i.id === input.instrumentId)) {
    throw new IntegrationError('not_found', 'No such instrument');
  }
  const same = and(
    eq(priceCharts.instrumentId, input.instrumentId),
    eq(priceCharts.interval, input.interval),
    eq(priceCharts.range, input.range),
  );
  const [recent] = await tx
    .select({ id: priceCharts.id })
    .from(priceCharts)
    .where(
      and(
        same,
        sql`(${priceCharts.status} = 'pending' OR (${priceCharts.status} = 'ready' AND ${priceCharts.createdAt} > now() - make_interval(secs => ${CHART_REUSE_SECONDS})))`,
      ),
    )
    .orderBy(desc(priceCharts.createdAt))
    .limit(1);
  if (recent) return getPriceChart(tx, recent.id);

  const [pending] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(priceCharts)
    .where(
      and(
        eq(priceCharts.status, 'pending'),
        gt(priceCharts.createdAt, sql`now() - interval '1 hour'`),
      ),
    );
  if ((pending?.n ?? 0) >= MAX_PENDING) {
    throw new IntegrationError('conflict', 'Wait for your other charts to load');
  }
  const window = chartWindow(input.range, input.now ?? new Date());
  const [row] = await tx
    .insert(priceCharts)
    .values({
      userId: input.userId,
      instrumentId: input.instrumentId,
      interval: input.interval,
      range: input.range,
      fromDate: window.from,
      toDate: window.to,
    })
    .returning({ id: priceCharts.id });
  if (!row) throw new Error('price chart insert failed');
  return getPriceChart(tx, row.id);
}

export async function getPriceChart(tx: Transaction, id: string): Promise<PriceChartSummary> {
  const [row] = await tx
    .select({
      chart: priceCharts,
      instrument: {
        id: instruments.id,
        symbol: instruments.symbol,
        displayName: instruments.displayName,
        assetClass: instruments.assetClass,
        venue: instruments.venue,
        kind: instruments.kind,
      },
    })
    .from(priceCharts)
    .innerJoin(instruments, eq(instruments.id, priceCharts.instrumentId))
    .where(eq(priceCharts.id, id));
  if (!row) throw new IntegrationError('not_found', 'No such chart');
  const c = row.chart;
  return {
    id: c.id,
    instrument: row.instrument,
    interval: c.interval as ChartInterval,
    range: c.range as ChartRange,
    from: c.fromDate,
    to: c.toDate,
    status: c.status,
    message: c.message,
    source: c.source,
    warnings: (c.warnings as string[] | null) ?? [],
    bars: (c.bars as ChartBarTuple[] | null) ?? null,
    createdAt: c.createdAt.toISOString(),
  };
}

// --- Worker side -------------------------------------------------------------

export async function claimPriceCharts(
  db: Database,
  options: { leaseSeconds: number; limit: number },
): Promise<{ chartId: string; userId: string }[]> {
  const rows = await db.execute<{ claimed_id: string; claimed_user: string }>(
    sql`select * from claim_price_charts(${options.leaseSeconds}, ${options.limit})`,
  );
  return rows.map((r) => ({ chartId: r.claimed_id, userId: r.claimed_user }));
}

export async function loadPendingChart(tx: Transaction, id: string) {
  const [row] = await tx
    .select({
      id: priceCharts.id,
      instrumentId: priceCharts.instrumentId,
      symbol: instruments.symbol,
      assetClass: instruments.assetClass,
      interval: priceCharts.interval,
      range: priceCharts.range,
      from: priceCharts.fromDate,
      to: priceCharts.toDate,
      attempts: priceCharts.attempts,
    })
    .from(priceCharts)
    .innerJoin(instruments, eq(instruments.id, priceCharts.instrumentId))
    .where(and(eq(priceCharts.id, id), eq(priceCharts.status, 'pending')));
  return row && { ...row, interval: row.interval as ChartInterval, range: row.range as ChartRange };
}

export async function finishPriceChart(
  tx: Transaction,
  id: string,
  outcome:
    | { status: 'ready'; bars: ChartBarTuple[]; warnings: string[]; source: string }
    | { status: 'failed'; message: string; source?: string | undefined }
    | { status: 'retry' },
): Promise<void> {
  // A retry keeps its lease, which then lapses and lets the chart be claimed again.
  if (outcome.status === 'retry') return;
  await tx
    .update(priceCharts)
    .set(
      outcome.status === 'ready'
        ? {
            status: 'ready',
            bars: outcome.bars,
            warnings: outcome.warnings.map((w) => w.slice(0, 300)).slice(0, 10),
            source: outcome.source.slice(0, 100),
            message: null,
          }
        : {
            status: 'failed',
            message: outcome.message.slice(0, 200),
            source: outcome.source?.slice(0, 100) ?? null,
          },
    )
    .where(and(eq(priceCharts.id, id), eq(priceCharts.status, 'pending')));
}
