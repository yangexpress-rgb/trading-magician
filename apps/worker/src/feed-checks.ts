import {
  claimFeedChecks,
  loadFeedToCheck,
  openCredential,
  recordFeedCheck,
  withTenant,
  type Database,
  type FeedCheckResult,
  type CredentialKey,
} from '@tm/db';
import type { Logger } from 'pino';
import { runCustomFeedTests } from './custom-feed-tests';
import type { Transport } from './custom-rest-transport';
import type { OptionsFeedProvider } from './options/feed';
import { withTimeout, type FundamentalsRegistry, type ProviderRegistry } from './providers';

/**
 * Checks data feeds (§9.2; ADR 0016): every feed someone pressed "Test" on,
 * and every active feed at least once a minute. Health, entitlement, the last
 * success and a short reason for a failure are stored on the feed; a feed
 * that goes down is announced.
 */

export const FEED_CHECKS = {
  everySeconds: 60,
  leaseSeconds: 30,
  timeoutMs: 10_000,
  batch: 10,
} as const;

export interface FeedCheckOptions {
  db: Database;
  providers: ProviderRegistry;
  /** Company data feeds are checked the same way (ADR 0031). */
  fundamentals?: FundamentalsRegistry | undefined;
  /** And options feeds, from the global recording's status (ADR 0047). */
  options?: Partial<Record<string, OptionsFeedProvider>> | undefined;
  privateKey: CredentialKey | undefined;
  logger: Pick<Logger, 'info' | 'warn'>;
  now?: () => Date;
  /** Tests and local checks only: how custom REST feeds are reached (ADR 0041). */
  customTransport?: Transport | undefined;
}

/** Checks one batch of due feeds; returns how many were checked. */
export async function runFeedChecks(options: FeedCheckOptions): Promise<number> {
  const claimed = await claimFeedChecks(options.db, {
    leaseSeconds: FEED_CHECKS.leaseSeconds,
    everySeconds: FEED_CHECKS.everySeconds,
    limit: FEED_CHECKS.batch,
  });
  for (const { feedId, userId } of claimed) {
    await withTenant(options.db, { userId }, async (tx) => {
      const feed = await loadFeedToCheck(tx, feedId);
      if (!feed) return;
      const now = (options.now ?? (() => new Date()))();
      const provider =
        options.providers[feed.provider] ??
        options.fundamentals?.[feed.provider] ??
        options.options?.[feed.provider];
      let result: FeedCheckResult;
      if (!provider) {
        result = { ok: false, entitlement: 'unknown', error: 'This provider is not available yet' };
      } else {
        try {
          const credential =
            feed.credentialRef && (provider.needsCredential || feed.config)
              ? await openCredential(tx, {
                  userId,
                  id: feed.credentialRef,
                  privateKey: options.privateKey,
                })
              : undefined;
          if (provider.needsCredential && !credential) {
            result = {
              ok: false,
              entitlement: 'unknown',
              error: 'No API key is set for this feed',
            };
          } else {
            result = await withTimeout(
              provider.check({
                now: () => now,
                credential,
                feed: { id: feed.id, config: feed.config },
                userId,
                inTenant: (fn) => fn(tx),
              }),
              FEED_CHECKS.timeoutMs,
              'The check',
            );
          }
        } catch (error) {
          // Never the provider's raw error, which may echo request details.
          const name = (error as Error).name;
          result = {
            ok: false,
            entitlement: 'unknown',
            error:
              name === 'CredentialError' || name === 'SealError'
                ? 'The stored API key could not be used'
                : name === 'SecRefusedError' || name === 'SecContactError'
                  ? 'The SEC refused the request. Check the contact email under Stored API keys.'
                  : /timed out/.test((error as Error).message)
                    ? 'The provider did not answer in time'
                    : 'The provider could not be reached',
          };
        }
      }
      await recordFeedCheck(tx, { userId, feed, result, now });
    });
  }
  return claimed.length;
}

export interface FeedCheckLoop {
  stop: () => Promise<void>;
}

export function startFeedCheckLoop(options: FeedCheckOptions & { pollMs: number }): FeedCheckLoop {
  let running = true;
  let wake: (() => void) | undefined;
  const sleep = () =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, options.pollMs);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  const done = (async () => {
    while (running) {
      try {
        await runFeedChecks(options);
        // Tests of custom feeds that are not saved yet ride along (ADR 0041).
        await runCustomFeedTests({ ...options, transport: options.customTransport });
      } catch (error) {
        const e = error as { name?: string; message?: string };
        options.logger.warn(
          { err: { name: e.name, message: e.message } },
          'feed checks unavailable',
        );
      }
      if (running) await sleep();
    }
  })();
  return {
    stop: async () => {
      running = false;
      wake?.();
      await done;
    },
  };
}
