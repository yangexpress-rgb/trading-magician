import { AlpacaAuthError } from '@tm/alpaca';
import {
  claimPriceCharts,
  finishPriceChart,
  loadPendingChart,
  withTenant,
  type ChartBarTuple,
  type Database,
  type Transaction,
  type CredentialKey,
} from '@tm/db';
import { BrokerUnavailableError, nyDate, UnsupportedBarRequestError } from '@tm/domain';
import type { Logger } from 'pino';
import { withTimeout, type ProviderRegistry } from './providers';
import { createRoutedHistory } from './routed-history';

/**
 * Answers price charts for Quantitative Research (ADR 0029): the bars come
 * through the tenant's bars route, like a back test's, split-adjusted and for
 * the regular session. A feed that cannot be reached is retried a few times,
 * then reported.
 */

export const CHARTS = { leaseSeconds: 30, batch: 5, maxAttempts: 3, timeoutMs: 20_000 } as const;

export interface PriceChartOptions {
  db: Database;
  providers: ProviderRegistry;
  privateKey: CredentialKey | undefined;
  logger: Pick<Logger, 'info' | 'warn'>;
  now?: () => Date;
}

export async function runPriceCharts(options: PriceChartOptions): Promise<number> {
  const claimed = await claimPriceCharts(options.db, {
    leaseSeconds: CHARTS.leaseSeconds,
    limit: CHARTS.batch,
  });
  const now = options.now ?? (() => new Date());
  for (const { chartId, userId } of claimed) {
    const inTenant = <T>(fn: (tx: Transaction) => Promise<T>) =>
      withTenant(options.db, { userId }, fn);
    const chart = await inTenant((tx) => loadPendingChart(tx, chartId));
    if (!chart) continue;
    let source: string | undefined;
    const history = createRoutedHistory({
      inTenant,
      userId,
      now,
      providers: options.providers,
      privateKey: options.privateKey,
      onFeed: (_id, feed) => {
        source = feed.name;
      },
    });
    try {
      const series = await withTimeout(
        history.getBars({
          instrumentId: chart.instrumentId,
          symbol: chart.symbol,
          assetClass: chart.assetClass,
          interval: chart.interval,
          from: chart.from,
          to: chart.to,
          adjustment: 'split_only',
          session: 'regular',
        }),
        CHARTS.timeoutMs,
        'The price request',
      );
      const nowMs = now().getTime();
      // Only finished bars, as everywhere else (ADR 0007).
      let finished = series.bars.filter((b) => Date.parse(b.end) <= nowMs);
      if (chart.range === '1d') {
        // One day is the latest session with bars: today's once it opens.
        const latest = finished.at(-1);
        const lastDay = latest ? nyDate(latest.start) : undefined;
        finished = finished.filter((b) => nyDate(b.start) === lastDay);
      }
      const bars: ChartBarTuple[] = finished.map((b) => [
        Date.parse(b.start),
        b.open.toNumber(),
        b.high.toNumber(),
        b.low.toNumber(),
        b.close.toNumber(),
        b.volume.toNumber(),
      ]);
      await inTenant((tx) =>
        finishPriceChart(tx, chartId, {
          status: 'ready',
          bars,
          warnings: series.warnings,
          source: source ?? 'Data feed',
        }),
      );
      options.logger.info({ chartId, bars: bars.length }, 'price chart ready');
    } catch (error) {
      const name = (error as Error).name;
      options.logger.warn({ chartId, err: { name } }, 'price chart failed');
      const feed = source ?? 'The data feed';
      let outcome: Parameters<typeof finishPriceChart>[2];
      if (error instanceof UnsupportedBarRequestError) {
        outcome = { status: 'failed', message: (error as Error).message, source };
      } else if (error instanceof AlpacaAuthError) {
        outcome = {
          status: 'failed',
          message: `${feed} refused its API key. Replace it under Stored API keys.`,
          source,
        };
      } else if (
        (error instanceof BrokerUnavailableError || /timed out/.test(String(error))) &&
        chart.attempts < CHARTS.maxAttempts
      ) {
        outcome = { status: 'retry' };
      } else {
        outcome = {
          status: 'failed',
          message: `${feed} could not give prices for ${chart.symbol}. Try again later.`,
          source,
        };
      }
      await inTenant((tx) => finishPriceChart(tx, chartId, outcome));
    }
  }
  return claimed.length;
}

export interface PriceChartLoop {
  stop: () => Promise<void>;
}

export function startPriceChartLoop(
  options: PriceChartOptions & { pollMs?: number },
): PriceChartLoop {
  const pollMs = options.pollMs ?? 1000;
  let running = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  const done = (async () => {
    while (running) {
      let handled = 0;
      try {
        handled = await runPriceCharts(options);
      } catch (error) {
        options.logger.warn(
          { err: { name: (error as Error).name } },
          'price chart queue unavailable',
        );
      }
      if (handled === 0 && running) {
        await new Promise<void>((resolve) => {
          wake = resolve;
          timer = setTimeout(resolve, pollMs);
        });
      }
    }
  })();
  return {
    stop: async () => {
      running = false;
      clearTimeout(timer);
      wake?.();
      await done;
    },
  };
}
