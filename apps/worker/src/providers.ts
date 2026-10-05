import type { FeedCheckResult, OpenedCredential } from '@tm/db';
import type { LiveQuoteProvider } from '@tm/domain';

/**
 * Market-data providers the worker can talk to (ADR 0016), keyed by the
 * provider id in the Settings catalog. A feed row picks one; its stored
 * credential, when the provider needs one, is opened only in memory.
 */
export interface ProviderContext {
  now: () => Date;
  credential?: OpenedCredential | undefined;
}

export interface MarketDataProvider {
  quotes(ctx: ProviderContext): LiveQuoteProvider;
  /** A light call that proves the connection and the account's entitlement. */
  check(ctx: ProviderContext): Promise<FeedCheckResult>;
  needsCredential: boolean;
}

export type ProviderRegistry = Partial<Record<string, MarketDataProvider>>;

/** The built-in demo feed: always reachable, simulated live prices. */
export function demoProvider(quotes: (now: () => Date) => LiveQuoteProvider): MarketDataProvider {
  return {
    needsCredential: false,
    quotes: ({ now }) => quotes(now),
    check: async () => ({ ok: true, entitlement: 'entitled', realtime: true }),
  };
}

/** Never let a provider call hang a pass. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
