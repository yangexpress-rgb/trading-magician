import {
  AlpacaBroker,
  AlpacaClient,
  alpacaCapabilities,
  checkAlpacaData,
  discoverAlpacaAccount,
  createAlpacaHistory,
  fetchDailyHistory,
  fetchSnapshots,
  screenSource,
  screenUniverse,
  createAlpacaQuotes,
  listAlpacaAssets,
  lookupAlpacaAsset,
  searchInstruments,
  type DiscoveredInstrument,
  type Fetch,
} from '@tm/alpaca';
import {
  addDays,
  nyDate,
  SCREEN_HISTORY_DAYS,
  type AccountCapabilities,
  type ScreenDay,
} from '@tm/domain';
import type { BrokerProvider } from './brokers';
import type { MarketDataProvider, ProviderContext, ScreenResult } from './providers';

/**
 * Alpaca as a market-data provider (ADR 0017): the free IEX feed for prices
 * and bars, and symbol lookups, all signed with the feed's stored paper key.
 */
export interface AlpacaProviderOptions {
  fetch?: Fetch | undefined;
  /** Tests and E2E only: a local fake in place of Alpaca's hosts. */
  fake?: { tradingUrl: string; dataUrl: string } | undefined;
  /** Tests only: waits between throttled screen requests. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

function clientFactory(options: AlpacaProviderOptions) {
  return (ctx: Pick<ProviderContext, 'credential'>) => {
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
}

/** Alpaca's list of assets changes a few times a day at most. */
export const ASSET_LIST_TTL_MS = 6 * 60 * 60 * 1000;
/** The screener's month of daily bars is asked for again at most this often within a day. */
export const SCREEN_HISTORY_TTL_MS = 2 * 60 * 60 * 1000;

const toListing = (found: DiscoveredInstrument) => ({
  assetClass: found.assetClass,
  symbol: found.symbol,
  venue: found.venue,
  displayName: found.displayName,
  providerId: found.providerId,
});

export function alpacaProvider(options: AlpacaProviderOptions = {}): MarketDataProvider {
  const clientFor = clientFactory(options);
  // The asset list is public reference data, the same for every account, so one
  // copy serves every tenant; each search still needs the tenant's own working key.
  let assets: { at: number; list: Promise<DiscoveredInstrument[]> } | undefined;
  const assetList = (client: AlpacaClient, nowMs: number) => {
    if (!assets || nowMs - assets.at > ASSET_LIST_TTL_MS) {
      const list = listAlpacaAssets(client);
      assets = { at: nowMs, list };
      // A failed download is not kept, so the next search tries again.
      list.catch(() => {
        if (assets?.list === list) assets = undefined;
      });
    }
    return assets.list;
  };
  // A month of daily bars for the screener changes once a day; the latest two
  // sessions come fresh with every screen's snapshots. Kept per key.
  const histories = new Map<
    string,
    { date: string; at: number; bars: Promise<Map<string, ScreenDay[]>> }
  >();
  const historyFor = (client: AlpacaClient, keyId: string, symbols: string[], now: Date) => {
    const today = nyDate(now);
    const nowMs = now.getTime();
    const cached = histories.get(keyId);
    if (cached && cached.date === today && nowMs - cached.at < SCREEN_HISTORY_TTL_MS) {
      return cached.bars;
    }
    const bars = fetchDailyHistory(client, symbols, addDays(today, -SCREEN_HISTORY_DAYS), {
      sleep: options.sleep,
    });
    const entry = { date: today, at: nowMs, bars };
    histories.set(keyId, entry);
    bars.catch(() => {
      if (histories.get(keyId) === entry) histories.delete(keyId);
    });
    return bars;
  };
  return {
    needsCredential: true,
    quotes: (ctx) => createAlpacaQuotes(clientFor(ctx), { now: ctx.now }),
    history: (ctx) => createAlpacaHistory(clientFor(ctx), { now: ctx.now }),
    check: (ctx) => checkAlpacaData(clientFor(ctx)),
    lookup: async (ctx, symbol) => {
      const found = await lookupAlpacaAsset(clientFor(ctx), symbol);
      return found ? toListing(found) : undefined;
    },
    search: async (ctx, query) => {
      const list = await assetList(clientFor(ctx), ctx.now().getTime());
      return searchInstruments(list, query).map(toListing);
    },
    screen: async (ctx): Promise<ScreenResult> => {
      const client = clientFor(ctx);
      const now = ctx.now();
      const universe = screenUniverse(await assetList(client, now.getTime()));
      const symbols = universe.map((a) => a.symbol);
      const [history, snaps] = await Promise.all([
        historyFor(client, ctx.credential?.fields.keyId ?? '', symbols, now),
        fetchSnapshots(client, symbols, { sleep: options.sleep }),
      ]);
      return {
        sources: universe.map((a) =>
          screenSource(a, history.get(a.symbol) ?? [], snaps.get(a.symbol)),
        ),
        warnings: [
          'Alpaca’s free feed has IEX exchange trades only, so volumes are lower than the whole market’s',
        ],
      };
    },
  };
}

/** Alpaca as a trading platform: one paper account per key (ADR 0018). */
export function alpacaBrokerProvider(options: AlpacaProviderOptions = {}): BrokerProvider {
  const clientFor = clientFactory(options);
  return {
    needsCredential: true,
    async discover(ctx) {
      const found = await discoverAlpacaAccount(clientFor(ctx));
      if (found.tradingBlocked) throw new Error('Alpaca has blocked trading on this account.');
      const caps = found.capabilities;
      const capabilities: AccountCapabilities = {
        assetClasses: found.assetClasses,
        orderTypes: [...caps.orderTypes],
        timeInForce: [...caps.timeInForce],
        sides: caps.shortSelling ? ['buy', 'sell', 'sell_short', 'buy_to_cover'] : ['buy', 'sell'],
        extendedHours: caps.extendedHours,
        shortSelling: caps.shortSelling,
        fractionalQuantity: caps.fractionalQuantities,
        atomicMultiLeg: caps.atomicMultiLeg,
        coverage: 'us',
      };
      return [
        {
          externalId: found.externalId,
          displayId: found.displayId,
          currency: found.currency,
          nickname: `Alpaca paper ${found.displayId}`,
          capabilities,
        },
      ];
    },
    adapter(ctx, account, instrumentIdFor) {
      return new AlpacaBroker({
        client: clientFor(ctx),
        capabilities: alpacaCapabilities({ shorting_enabled: account.capabilities.shortSelling }),
        instrumentIdFor,
      });
    },
  };
}
