import {
  AlpacaClient,
  checkAlpacaData,
  createAlpacaHistory,
  createAlpacaQuotes,
  lookupAlpacaAsset,
  type Fetch,
} from '@tm/alpaca';
import type { MarketDataProvider, ProviderContext } from './providers';

/**
 * Alpaca as a market-data provider (ADR 0017): the free IEX feed for prices
 * and bars, and symbol lookups, all signed with the feed's stored paper key.
 */
export interface AlpacaProviderOptions {
  fetch?: Fetch | undefined;
  /** Tests and E2E only: a local fake in place of Alpaca's hosts. */
  fake?: { tradingUrl: string; dataUrl: string } | undefined;
}

export function alpacaProvider(options: AlpacaProviderOptions = {}): MarketDataProvider {
  const clientFor = (ctx: ProviderContext) => {
    const fields = ctx.credential?.fields;
    if (ctx.credential?.provider !== 'alpaca' || !fields?.keyId || !fields.secretKey) {
      throw new Error('No Alpaca key is stored for this feed');
    }
    return new AlpacaClient({
      credentials: { keyId: fields.keyId, secretKey: fields.secretKey },
      fetch: options.fetch,
      ...(options.fake
        ? { tradingUrl: options.fake.tradingUrl, dataUrl: options.fake.dataUrl, allowLocal: true }
        : {}),
    });
  };
  return {
    needsCredential: true,
    quotes: (ctx) => createAlpacaQuotes(clientFor(ctx), { now: ctx.now }),
    history: (ctx) => createAlpacaHistory(clientFor(ctx), { now: ctx.now }),
    check: (ctx) => checkAlpacaData(clientFor(ctx)),
    lookup: async (ctx, symbol) => {
      const found = await lookupAlpacaAsset(clientFor(ctx), symbol);
      if (!found) return undefined;
      return {
        assetClass: found.assetClass,
        symbol: found.symbol,
        venue: found.venue,
        displayName: found.displayName,
        providerId: found.providerId,
      };
    },
  };
}
