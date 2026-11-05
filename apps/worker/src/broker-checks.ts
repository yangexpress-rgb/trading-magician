import { AlpacaAuthError } from '@tm/alpaca';
import {
  claimBrokerChecks,
  loadPlatformToCheck,
  openCredential,
  recordPlatformCheck,
  withTenant,
  type Database,
  type DiscoveredAccountInput,
  type CredentialKey,
} from '@tm/db';
import type { Logger } from 'pino';
import type { BrokerRegistry } from './brokers';
import { withTimeout } from './providers';

/**
 * Checks trading platforms (§9.3; ADR 0018): each one someone connected or
 * tested, and each active one every few minutes. A check proves the key and
 * rediscovers the accounts it reaches, refreshing their capabilities.
 */

export const BROKER_CHECKS = {
  everySeconds: 300,
  leaseSeconds: 30,
  timeoutMs: 10_000,
  batch: 10,
} as const;

export interface BrokerCheckOptions {
  db: Database;
  brokers: BrokerRegistry;
  privateKey: CredentialKey | undefined;
  logger: Pick<Logger, 'info' | 'warn'>;
  now?: () => Date;
}

/** A short reason for the person; never the provider's raw error. */
function reason(error: unknown): string {
  const e = error as Error;
  if (error instanceof AlpacaAuthError) {
    return 'Alpaca refused the API key. Replace it under Stored API keys.';
  }
  if (e.name === 'CredentialError' || e.name === 'SealError') {
    return 'The stored API key could not be used';
  }
  if (e.message === 'Alpaca has blocked trading on this account.') return e.message;
  if (/timed out/.test(e.message)) return 'The platform did not answer in time';
  return 'The platform could not be reached';
}

export async function runBrokerChecks(options: BrokerCheckOptions): Promise<number> {
  const claimed = await claimBrokerChecks(options.db, {
    leaseSeconds: BROKER_CHECKS.leaseSeconds,
    everySeconds: BROKER_CHECKS.everySeconds,
    limit: BROKER_CHECKS.batch,
  });
  for (const { platformId, userId } of claimed) {
    await withTenant(options.db, { userId }, async (tx) => {
      const platform = await loadPlatformToCheck(tx, platformId);
      if (!platform) return;
      const now = (options.now ?? (() => new Date()))();
      if (platform.provider === 'demo') {
        await recordPlatformCheck(tx, { userId, platform, now, ok: true });
        return;
      }
      const provider = options.brokers[platform.provider];
      if (!provider) {
        await recordPlatformCheck(tx, {
          userId,
          platform,
          now,
          ok: false,
          error: 'This platform is not available yet',
        });
        return;
      }
      let accounts: DiscoveredAccountInput[];
      try {
        const credential =
          provider.needsCredential && platform.credentialRef
            ? await openCredential(tx, {
                userId,
                id: platform.credentialRef,
                privateKey: options.privateKey,
              })
            : undefined;
        if (provider.needsCredential && !credential) {
          await recordPlatformCheck(tx, {
            userId,
            platform,
            now,
            ok: false,
            error: 'No API key is set for this platform',
          });
          return;
        }
        accounts = await withTimeout(
          provider.discover({ now: () => now, credential }),
          BROKER_CHECKS.timeoutMs,
          'The check',
        );
      } catch (error) {
        options.logger.warn(
          { platformId, err: { name: (error as Error).name } },
          'platform check failed',
        );
        await recordPlatformCheck(tx, { userId, platform, now, ok: false, error: reason(error) });
        return;
      }
      await recordPlatformCheck(tx, { userId, platform, now, ok: true, accounts });
    });
  }
  return claimed.length;
}

export interface BrokerCheckLoop {
  stop: () => Promise<void>;
}

export function startBrokerCheckLoop(
  options: BrokerCheckOptions & { pollMs: number },
): BrokerCheckLoop {
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
        await runBrokerChecks(options);
      } catch (error) {
        const e = error as { name?: string; message?: string };
        options.logger.warn(
          { err: { name: e.name, message: e.message } },
          'platform checks unavailable',
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
