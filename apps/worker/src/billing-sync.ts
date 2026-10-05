import type { BillingProvider } from '@tm/billing';
import {
  applySubscription,
  claimSubscriptionSyncs,
  getSubscription,
  planPrices,
  runBillingGrace,
  withTenant,
  type Database,
} from '@tm/db';
import type { Logger } from 'pino';

/**
 * The worker's billing jobs. Every minute: payment grace reminders and the
 * grace period's end (ADR 0024). With a provider key: each live subscription
 * is re-read hourly in case a webhook was missed (ADR 0023); webhooks stay
 * the main path and this only catches up.
 */

export const SUBSCRIPTION_SYNC = {
  everySeconds: 3600,
  leaseSeconds: 60,
  batch: 20,
} as const;

export interface SubscriptionSyncOptions {
  db: Database;
  provider: BillingProvider;
  logger: Pick<Logger, 'info' | 'warn'>;
  everySeconds?: number;
}

export async function runSubscriptionSyncs(options: SubscriptionSyncOptions): Promise<number> {
  const claimed = await claimSubscriptionSyncs(options.db, {
    leaseSeconds: SUBSCRIPTION_SYNC.leaseSeconds,
    everySeconds: options.everySeconds ?? SUBSCRIPTION_SYNC.everySeconds,
    limit: SUBSCRIPTION_SYNC.batch,
  });
  for (const { userId, subscriptionId } of claimed) {
    try {
      const remote = await options.provider.getSubscription(subscriptionId);
      await withTenant(options.db, { userId }, async (tx) => {
        const local = await getSubscription(tx);
        if (!local.customerId) return;
        await applySubscription(tx, {
          userId,
          // A subscription the provider no longer knows has ended.
          state: remote
            ? {
                customerId: remote.customerId,
                subscriptionId: remote.id,
                status: remote.status,
                priceId: remote.priceId,
                currentPeriodEnd: remote.currentPeriodEnd,
                cancelAtPeriodEnd: remote.cancelAtPeriodEnd,
              }
            : {
                customerId: local.customerId,
                subscriptionId,
                status: 'canceled',
                priceId: null,
                currentPeriodEnd: local.currentPeriodEnd,
                cancelAtPeriodEnd: false,
              },
          prices: await planPrices(tx),
          reason: 'resync',
        });
      });
    } catch (error) {
      // The lease lapses and the subscription is tried again.
      options.logger.warn(
        { userId, err: { name: (error as Error).name, message: (error as Error).message } },
        'subscription sync failed',
      );
    }
  }
  return claimed.length;
}

export interface BillingLoop {
  stop: () => Promise<void>;
}

export interface BillingLoopOptions {
  db: Database;
  /** Without one, only the grace period is looked after. */
  provider: BillingProvider | undefined;
  /** Tests only: plans' prices are the stand-in's made-up ones. */
  fakePrices: boolean;
  logger: Pick<Logger, 'info' | 'warn'>;
  pollMs: number;
}

export function startBillingLoop(options: BillingLoopOptions): BillingLoop {
  const { provider } = options;
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
        await runBillingGrace(options.db, {
          prices: (tx) => planPrices(tx, options.fakePrices),
        });
        if (provider) await runSubscriptionSyncs({ ...options, provider });
      } catch (error) {
        const e = error as { name?: string; message?: string };
        options.logger.warn({ err: { name: e.name, message: e.message } }, 'billing jobs failed');
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
