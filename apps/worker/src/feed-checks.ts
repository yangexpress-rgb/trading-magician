import {
  claimFeedChecks,
  loadFeedToCheck,
  openCredential,
  recordFeedCheck,
  withTenant,
  type Database,
  type FeedCheckResult,
} from '@tm/db';
import type { Logger } from 'pino';
import { withTimeout, type ProviderRegistry } from './providers';

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
  privateKey: string | undefined;
  logger: Pick<Logger, 'info' | 'warn'>;
  now?: () => Date;
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
      const provider = options.providers[feed.provider];
      let result: FeedCheckResult;
      if (!provider) {
        result = { ok: false, entitlement: 'unknown', error: 'This provider is not available yet' };
      } else {
        try {
          const credential =
            provider.needsCredential && feed.credentialRef
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
              provider.check({ now: () => now, credential }),
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
