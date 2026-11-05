import {
  activeFundamentalsFeed,
  claimCompanyReports,
  finishCompanyReport,
  loadPendingCompanyReport,
  openCredential,
  withTenant,
  type Database,
  type Transaction,
  type CredentialKey,
} from '@tm/db';
import { BrokerUnavailableError } from '@tm/domain';
import type { Logger } from 'pino';
import { withTimeout, type FundamentalsRegistry } from './providers';

/**
 * Answers company pages for Quantitative Research (ADR 0031) from the
 * tenant's company data feed: profile, five fiscal years and recent filings.
 * A provider that cannot be reached is retried a few times, then reported.
 */

export const COMPANIES = { leaseSeconds: 60, batch: 3, maxAttempts: 3, timeoutMs: 45_000 } as const;

export interface CompanyReportOptions {
  db: Database;
  fundamentals: FundamentalsRegistry;
  privateKey: CredentialKey | undefined;
  logger: Pick<Logger, 'info' | 'warn'>;
  now?: () => Date;
}

export async function runCompanyReports(options: CompanyReportOptions): Promise<number> {
  const claimed = await claimCompanyReports(options.db, {
    leaseSeconds: COMPANIES.leaseSeconds,
    limit: COMPANIES.batch,
  });
  const now = options.now ?? (() => new Date());
  for (const { reportId, userId } of claimed) {
    const inTenant = <T>(fn: (tx: Transaction) => Promise<T>) =>
      withTenant(options.db, { userId }, fn);
    const pending = await inTenant((tx) => loadPendingCompanyReport(tx, reportId));
    if (!pending) continue;
    let source: string | undefined;
    try {
      const { feed, credential } = await inTenant(async (tx) => {
        const feed = await activeFundamentalsFeed(tx);
        const provider = feed ? options.fundamentals[feed.provider] : undefined;
        const credential =
          feed && provider?.needsCredential && feed.credentialRef
            ? await openCredential(tx, {
                userId,
                id: feed.credentialRef,
                privateKey: options.privateKey,
              })
            : undefined;
        return { feed, credential };
      });
      const provider = feed ? options.fundamentals[feed.provider] : undefined;
      if (!feed || !provider) {
        await inTenant((tx) =>
          finishCompanyReport(tx, reportId, {
            status: 'failed',
            message:
              'Add a company data feed under Settings › Data feeds to see company financials.',
          }),
        );
        continue;
      }
      source = feed.name;
      const report = await withTimeout(
        provider.report({ now, credential }, pending.symbol),
        COMPANIES.timeoutMs,
        'The company request',
      );
      await inTenant((tx) =>
        finishCompanyReport(
          tx,
          reportId,
          report
            ? { status: 'ready', report, source: feed.name }
            : {
                status: 'failed',
                message: `${feed.name} has no company filings for ${pending.symbol}. ETFs and funds file no company financials.`,
                source: feed.name,
              },
        ),
      );
      options.logger.info({ reportId, found: !!report }, 'company report done');
    } catch (error) {
      const name = (error as Error).name;
      options.logger.warn({ reportId, err: { name } }, 'company report failed');
      const feed = source ?? 'The company data feed';
      let outcome: Parameters<typeof finishCompanyReport>[2];
      if (name === 'SecRefusedError' || name === 'SecContactError') {
        outcome = {
          status: 'failed',
          message: `${feed} refused the request. Check its contact email under Stored API keys.`,
          source,
        };
      } else if (name === 'CredentialError' || name === 'SealError') {
        outcome = {
          status: 'failed',
          message: `${feed} could not use its stored contact.`,
          source,
        };
      } else if (
        (error instanceof BrokerUnavailableError || /timed out/.test(String(error))) &&
        pending.attempts < COMPANIES.maxAttempts
      ) {
        outcome = { status: 'retry' };
      } else {
        outcome = {
          status: 'failed',
          message: `${feed} could not give company data for ${pending.symbol}. Try again later.`,
          source,
        };
      }
      await inTenant((tx) => finishCompanyReport(tx, reportId, outcome));
    }
  }
  return claimed.length;
}

export interface CompanyReportLoop {
  stop: () => Promise<void>;
}

export function startCompanyReportLoop(
  options: CompanyReportOptions & { pollMs?: number },
): CompanyReportLoop {
  const pollMs = options.pollMs ?? 1000;
  let running = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  const done = (async () => {
    while (running) {
      let handled = 0;
      try {
        handled = await runCompanyReports(options);
      } catch (error) {
        options.logger.warn(
          { err: { name: (error as Error).name } },
          'company report queue unavailable',
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
