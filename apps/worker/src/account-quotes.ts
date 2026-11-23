import {
  accountFeedChain,
  applyChainStep,
  loadRouting,
  type AccountFeedChain,
  type CredentialKey,
  type FeedScope,
  type Routing,
  type Transaction,
} from '@tm/db';
import {
  chainStep,
  FAILOVER,
  quoteAgeSec,
  type ChainStep,
  type Quote,
  type QuoteRequest,
} from '@tm/domain';
import type { Logger } from 'pino';
import type { ProviderRegistry } from './providers';
import { createFeedAsker, createRoutedQuotes, type RoutedQuotes } from './routed-quotes';

export interface AccountQuotes extends RoutedQuotes {
  /** What this pass decided for the account's feeds; undefined until it has looked. */
  readonly step: ChainStep | undefined;
}

/**
 * Prices for one pass from an account's own feeds (Phase 7 P2, ADR 0108): the
 * feed pricing the account now answers every instrument. The chain is looked
 * at once per pass, on the first instrument asked for: when that feed stops,
 * the account moves to the next feed that answers, or pauses its runs if it is
 * set to; once the primary has looked healthy for five minutes prices move
 * back to it. With `decide` off (valuations) it only reads the feed in use.
 */
export function createAccountQuotes(options: {
  tx: Transaction;
  userId: string;
  now: Date;
  chain: AccountFeedChain;
  feeds: Routing['feeds'];
  providers: ProviderRegistry;
  privateKey: CredentialKey | undefined;
  logger: Pick<Logger, 'warn'>;
  decide: boolean;
}): AccountQuotes {
  const { tx, now, chain } = options;
  const asker = createFeedAsker({
    tx,
    userId: options.userId,
    now,
    feeds: options.feeds,
    providers: options.providers,
    privateKey: options.privateKey,
    logger: options.logger,
  });
  const primary = chain.feeds[0]?.id ?? '';
  const stored =
    chain.activeId && chain.feeds.some((f) => f.id === chain.activeId) ? chain.activeId : null;
  let step: ChainStep | undefined;
  let decided: Promise<string> | undefined;

  // A feed that answers, with a current price while the market is open.
  const healthy = (q: Quote | undefined) =>
    q !== undefined && (!q.marketOpen || quoteAgeSec(q, now) <= FAILOVER.staleSec);

  function feedFor(ref: QuoteRequest): Promise<string> {
    if (!options.decide) return Promise.resolve(stored ?? primary);
    decided ??= (async () => {
      const active = stored ?? primary;
      const health = new Map<string, boolean>();
      const look = async (ids: string[]) => {
        const quotes = await Promise.all(ids.map((id) => asker.ask(id, ref)));
        ids.forEach((id, i) => health.set(id, healthy(quotes[i])));
      };
      await look([active]);
      if (!health.get(active) && chain.onFailure === 'fallback') {
        await look(chain.feeds.map((f) => f.id).filter((id) => id !== active));
      } else if (active !== primary) {
        await look([primary]);
      }
      step = chainStep({
        chain: chain.feeds.map((f) => f.id),
        active: stored,
        primaryOkSince: chain.primaryOkSince,
        mode: chain.onFailure,
        pausedForFeed: chain.pausedForFeed,
        healthy: (id) => health.get(id) ?? false,
        now,
      });
      const after = await applyChainStep(tx, { userId: options.userId, chain, step, now });
      return after ?? primary;
    })();
    return decided;
  }

  return {
    id: 'account',
    get step() {
      return step;
    },
    async latestQuote(ref) {
      return asker.ask(await feedFor(ref), ref);
    },
    async freshQuote(ref) {
      return asker.askFresh(await feedFor(ref), ref);
    },
    async prefetch(refs) {
      const [first] = refs;
      if (!first) return;
      const feedId = await feedFor(first);
      const list = refs.filter((r) => !asker.has(feedId, r.instrumentId));
      await asker.prefetchFrom(feedId, list);
    },
  };
}

/**
 * The quotes a run or an account valuation prices from: the account's own
 * feeds when it has any, otherwise the data routes (the tenant's, or the
 * admin's shared ones, N237).
 */
export async function quotesForAccount(options: {
  tx: Transaction;
  userId: string;
  accountId: string | null;
  now: Date;
  providers: ProviderRegistry;
  privateKey: CredentialKey | undefined;
  logger: Pick<Logger, 'warn'>;
  feeds: FeedScope;
  decide: boolean;
}): Promise<RoutedQuotes & { step?: ChainStep | undefined }> {
  const { tx, feeds } = options;
  const chain = options.accountId ? await accountFeedChain(tx, options.accountId) : undefined;
  if (chain && chain.feeds.length > 0) {
    // An account's feeds are the tenant's own.
    const own = await loadRouting(tx);
    return createAccountQuotes({ ...options, chain, feeds: own.feeds });
  }
  return createRoutedQuotes({
    tx,
    userId: options.userId,
    now: options.now,
    routing: feeds.shared ? await feeds.inTenant(loadRouting) : await loadRouting(tx),
    providers: options.providers,
    privateKey: options.privateKey,
    logger: options.logger,
    feeds: feeds.shared ? feeds : undefined,
  });
}
