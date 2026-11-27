import {
  ensureOptionInstrument,
  loadContractList,
  instrumentsBySymbol,
  isOptionsAccount,
  type Transaction,
} from '@tm/db';
import {
  BrokerUnavailableError,
  OCC_SYMBOL,
  OPTIONS_DEFAULTS,
  parseOccSymbol,
  type BrokerAdapter,
} from '@tm/domain';
import type { Logger } from 'pino';

/**
 * The options lifecycle job (options trading brief v0.2 §5.8, ADR 0123). It
 * runs only while `OPTIONS_TRADING_ENABLED` is on, only on accounts that carry
 * options runs, and on each of them **before** that account's reconciliation
 * pass, so whatever it explains is never seen as an unexplained mismatch.
 *
 * Phase O0 gives it one duty: a contract the broker holds that the app has no
 * instrument for (an OCC holding created outside the app) is registered as a
 * Core instrument, so reconciliation knows it as one of the app's own and
 * pauses only what trades it, never every run on the account (§5.3, A11).
 * Expiry-day handling, exercise and assignment and the dividend watch follow
 * with the phases that place options orders.
 */
export interface OptionsLifecycle {
  beforeReconcile(
    tx: Transaction,
    broker: BrokerAdapter,
    accountId: string,
    now: Date,
  ): Promise<void>;
}

/** A broker holding the app has no instrument for carries this stand-in id (`alpaca:SYMBOL`). */
const standIn = /^[a-z]+:(.+)$/;

export function createOptionsLifecycle(options: {
  logger: Pick<Logger, 'info' | 'warn'>;
}): OptionsLifecycle {
  return {
    async beforeReconcile(tx, broker, accountId) {
      if (!(await isOptionsAccount(tx, accountId))) return;
      let held;
      try {
        held = await broker.positions(accountId);
      } catch (e) {
        if (e instanceof BrokerUnavailableError) return;
        throw e;
      }
      for (const p of held) {
        const symbol = standIn.exec(p.instrumentId)?.[1];
        if (!symbol || !OCC_SYMBOL.test(symbol)) continue;
        const occ = parseOccSymbol(symbol);
        if (!occ) continue;
        const underlying = (await instrumentsBySymbol(tx, [occ.root])).get(occ.root);
        if (!underlying) {
          options.logger.warn(
            { accountId, symbol },
            'options holding on an underlying the app has no instrument for',
          );
          continue;
        }
        // O220: the cached contract list's multiplier when it lists the contract, else 100.
        const listed = (await loadContractList(tx, underlying))?.contracts.find(
          (c) => c.symbol === symbol,
        );
        await ensureOptionInstrument(tx, {
          underlyingId: underlying,
          symbol,
          expiry: occ.expiry,
          strike: String(occ.strike),
          right: occ.right,
          multiplier: listed?.multiplier ?? String(OPTIONS_DEFAULTS.standardMultiplier),
          provider: 'alpaca',
          providerId: symbol,
        });
        options.logger.info({ accountId, symbol }, 'options holding registered as an instrument');
      }
    },
  };
}
