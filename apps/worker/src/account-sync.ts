import { AlpacaRateLimitError } from '@tm/alpaca';

/**
 * One broker-account sync shared by every strategy on the account (N280, ADR 0097).
 *
 * Each pass asks the broker for the account's new orders and fills. Eight
 * strategies on one Alpaca account, each passing every 5 s, asked the same
 * question eight times over: about 190 requests a minute on a key Alpaca
 * limits to 200. The gate lets one pass sync the account and the others,
 * within `everyMs`, reuse that result: the updates are in the database for
 * every runtime to read, and the broker's health is remembered here.
 */

export interface SyncOutcome {
  brokerDown: boolean;
  throttled: boolean;
}

export class AccountSyncGate {
  private readonly last = new Map<string, { at: number; outcome: SyncOutcome }>();

  constructor(private readonly everyMs: number) {}

  /** Whether this pass should ask the broker itself. */
  due(accountId: string, t: number): boolean {
    if (this.everyMs <= 0) return true;
    const prev = this.last.get(accountId);
    return !prev || t - prev.at >= this.everyMs || t < prev.at;
  }

  record(accountId: string, t: number, outcome: SyncOutcome): void {
    this.last.set(accountId, { at: t, outcome });
  }

  /** What the last sync of the account found, for a pass that skipped it. */
  outcome(accountId: string): SyncOutcome | undefined {
    return this.last.get(accountId)?.outcome;
  }
}

/**
 * Alpaca answered "too many requests" (429). The broker is there; the key is
 * over its limit, which passes on its own, so this is not broker silence.
 */
export function isThrottled(e: unknown): boolean {
  return e instanceof AlpacaRateLimitError;
}
