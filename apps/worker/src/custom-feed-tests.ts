import {
  claimCustomFeedTests,
  finishCustomFeedTest,
  loadCustomFeedTest,
  openCredential,
  withTenant,
  type CredentialKey,
  type Database,
} from '@tm/db';
import type { Logger } from 'pino';
import { runCustomTest } from './custom-rest';
import type { Transport } from './custom-rest-transport';

/**
 * Runs the tests people ask for before saving a custom REST feed (ADR 0041):
 * the key is opened in memory only, the provider is called outside any
 * transaction, and the outcome is stored for the page to show.
 */
export const CUSTOM_TESTS = { leaseSeconds: 60, batch: 5 } as const;

export async function runCustomFeedTests(options: {
  db: Database;
  privateKey: CredentialKey | undefined;
  logger: Pick<Logger, 'warn'>;
  transport?: Transport | undefined;
  now?: () => Date;
}): Promise<number> {
  const claimed = await claimCustomFeedTests(options.db, {
    leaseSeconds: CUSTOM_TESTS.leaseSeconds,
    limit: CUSTOM_TESTS.batch,
  });
  for (const { testId, userId } of claimed) {
    const inTenant = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
      withTenant(options.db, { userId }, fn);
    let outcome: Awaited<ReturnType<typeof runCustomTest>>;
    try {
      const loaded = await inTenant(async (tx) => {
        const test = await loadCustomFeedTest(tx, testId);
        if (!test) return undefined;
        const credential = test.credentialRef
          ? await openCredential(tx, {
              userId,
              id: test.credentialRef,
              privateKey: options.privateKey,
            })
          : undefined;
        return { test, apiKey: credential?.fields.apiKey };
      });
      if (!loaded) continue;
      outcome = await runCustomTest({
        config: loaded.test.config,
        apiKey: loaded.apiKey,
        symbol: loaded.test.symbol,
        now: (options.now ?? (() => new Date()))(),
        transport: options.transport,
      });
    } catch (error) {
      const name = (error as Error).name;
      options.logger.warn({ testId, err: { name } }, 'custom feed test failed to run');
      outcome = {
        ok: false,
        message:
          name === 'CredentialError' || name === 'SealError'
            ? 'The stored API key could not be used'
            : 'The test could not be run',
      };
    }
    await inTenant((tx) => finishCustomFeedTest(tx, { id: testId, ...outcome }));
  }
  return claimed.length;
}
