import { sharedAlpacaBudget, type AlpacaRequestBudget } from '@tm/alpaca';
import type { Logger } from 'pino';
import { drainBatchFailures, drainQuoteTrail } from './routed-quotes';

/**
 * Logs, once a minute, what the worker asked Alpaca for and what came back
 *: requests per key split by data/trading and foreground/background,
 * 429s, timeouts, the busiest routes, and the runtimes' quote asks per symbol
 * with the last time each one worked. It changes nothing; it is there so a
 * "no price" incident can be traced to throttling, timeouts or a missing reply.
 */
export interface TrafficLog {
  stop(): void;
  /** Tests: logs now. */
  flush(): void;
}

export function startTrafficLog(options: {
  logger: Pick<Logger, 'info' | 'warn'>;
  everyMs?: number;
  budget?: AlpacaRequestBudget;
}): TrafficLog {
  const budget = options.budget ?? sharedAlpacaBudget;
  const flush = () => {
    for (const key of budget.drainTraffic()) {
      const log = key.throttled > 0 || key.timeouts > 0 ? options.logger.warn : options.logger.info;
      log.call(options.logger, { event: 'alpaca.traffic', ...key }, 'alpaca requests last minute');
    }
    const symbols = drainQuoteTrail();
    const batches = drainBatchFailures();
    const failed = symbols.filter((s) => s.failed > 0);
    if (symbols.length === 0) return;
    const log = failed.length > 0 ? options.logger.warn : options.logger.info;
    log.call(
      options.logger,
      {
        event: 'quotes.trail',
        symbols: symbols.length,
        asks: symbols.reduce((n, s) => n + s.asked, 0),
        failedAsks: failed.reduce((n, s) => n + s.failed, 0),
        batchFailures: batches,
        // Every symbol that failed at least once, with when it last worked.
        failed: failed.slice(0, 50),
      },
      'runtime quote asks last minute',
    );
  };
  const timer = setInterval(flush, options.everyMs ?? 60_000);
  timer.unref?.();
  return {
    stop: () => clearInterval(timer),
    flush,
  };
}
