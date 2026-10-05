import { PaperBroker } from '@tm/broker';
import {
  claimValuations,
  DbPaperBrokerStore,
  instrumentsToMark,
  loadAccountRouting,
  loadAccountToValue,
  loadLedger,
  loadRouting,
  recordValuation,
  releaseValuation,
  withTenant,
  type Database,
  type ValuationInput,
} from '@tm/db';
import { markFromQuote, valuationSession, type BrokerAdapter, type Mark } from '@tm/domain';
import Decimal from 'decimal.js';
import type { Logger } from 'pino';
import { accountResolver } from './account-router';
import type { BrokerRegistry } from './brokers';
import { withTimeout, type ProviderRegistry } from './providers';
import { createRoutedQuotes } from './routed-quotes';

/**
 * Values trading accounts (Design v1.0 §10.2; ADR 0020): every few minutes
 * each account's ledger is marked at the tenant's routed prices and stored
 * as that session's equity; from the 4:00 pm close the valuation is final
 * and is compared with what the broker holds.
 */

export const VALUATIONS = {
  everySeconds: 300,
  leaseSeconds: 60,
  timeoutMs: 10_000,
  batch: 10,
} as const;

export interface ValuationOptions {
  db: Database;
  providers: ProviderRegistry;
  brokers: BrokerRegistry | undefined;
  privateKey: string | undefined;
  logger: Pick<Logger, 'info' | 'warn'>;
  now?: () => Date;
  everySeconds?: number;
}

export async function runValuations(options: ValuationOptions): Promise<number> {
  const claimed = await claimValuations(options.db, {
    leaseSeconds: VALUATIONS.leaseSeconds,
    everySeconds: options.everySeconds ?? VALUATIONS.everySeconds,
    limit: VALUATIONS.batch,
  });
  for (const { accountId, userId } of claimed) {
    try {
      await valueAccount(options, accountId, userId);
    } catch (error) {
      // The lease lapses and the account is tried again.
      options.logger.warn(
        { accountId, err: { name: (error as Error).name, message: (error as Error).message } },
        'valuation failed',
      );
    }
  }
  return claimed.length;
}

export async function valueAccount(
  options: ValuationOptions,
  accountId: string,
  userId: string,
): Promise<void> {
  const now = (options.now ?? (() => new Date()))();
  const session = valuationSession(now);
  await withTenant(options.db, { userId }, async (tx) => {
    const account = await loadAccountToValue(tx, accountId, session.date);
    if (!account) return;
    if (account.finalRecorded) {
      await releaseValuation(tx, accountId);
      return;
    }
    const { ledger } = await loadLedger(tx, { accountIds: [accountId] });

    // Marks come through the tenant's routes, like the strategies' prices (ADR 0016).
    const quotes = createRoutedQuotes({
      tx,
      userId,
      now,
      routing: await loadRouting(tx),
      providers: options.providers,
      privateKey: options.privateKey,
      logger: options.logger,
    });
    const marks = new Map<string, Mark>();
    for (const ref of await instrumentsToMark(tx, ledger)) {
      const quote = await quotes.latestQuote(ref).catch(() => undefined);
      if (quote) marks.set(ref.instrumentId, markFromQuote(quote, now, session.close));
    }

    // What the broker reports. The simulator holds no cash, so only its positions count.
    let broker: ValuationInput['broker'];
    let final = session.final;
    try {
      const routing = await loadAccountRouting(tx, [accountId]);
      const paper = new PaperBroker({
        quotes,
        store: new DbPaperBrokerStore(tx, userId),
        now: () => now,
      });
      const adapter: BrokerAdapter = await accountResolver({
        tx,
        userId,
        accounts: routing,
        paper,
        brokers: options.brokers,
        privateKey: options.privateKey,
        now: () => now,
      })(accountId);
      const [balance, positions] = await withTimeout(
        Promise.all([
          adapter.account ? adapter.account(accountId) : Promise.resolve(undefined),
          adapter.positions(accountId),
        ]),
        VALUATIONS.timeoutMs,
        'The broker',
      );
      broker = {
        balance,
        positions: new Map(positions.map((p) => [p.instrumentId, new Decimal(p.quantity)])),
      };
    } catch (error) {
      // Without the broker the close cannot be checked; it stays open and is retried.
      final = false;
      options.logger.warn(
        { accountId, err: { name: (error as Error).name } },
        'broker could not be asked for valuation',
      );
    }

    await recordValuation(tx, {
      userId,
      account,
      session: { date: session.date, final },
      now,
      ledger,
      marks,
      broker,
    });
  });
}

export interface ValuationLoop {
  stop: () => Promise<void>;
}

export function startValuationLoop(options: ValuationOptions & { pollMs: number }): ValuationLoop {
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
        await runValuations(options);
      } catch (error) {
        const e = error as { name?: string; message?: string };
        options.logger.warn(
          { err: { name: e.name, message: e.message } },
          'valuations unavailable',
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
