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
  type AlpacaSnapshot,
  type DiscoveredInstrument,
  type Fetch,
} from '@tm/alpaca';
import {
  addDays,
  liveTradingEnabled,
  nyDate,
  regularSession,
  SCREEN_HISTORY_DAYS,
  type AccountCapabilities,
  type ScreenDay,
} from '@tm/domain';
import type { BrokerProvider } from './brokers';
import type {
  MarketDataProvider,
  ProviderContext,
  ScreenResult,
  WatchPriceResult,
} from './providers';

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
  return (
    ctx: Pick<ProviderContext, 'credential' | 'background'> & {
      environment?: 'paper' | 'live' | undefined;
    },
  ) => {
    const fields = ctx.credential?.fields;
    if (ctx.credential?.provider !== 'alpaca' || !fields?.keyId || !fields.secretKey) {
      throw new Error('No Alpaca key is stored for this feed');
    }
    return new AlpacaClient({
      credentials: { keyId: fields.keyId, secretKey: fields.secretKey },
      fetch: options.fetch,
      background: ctx.background ?? false,
      // A live account's host only while the server's flag is on (ADR 0109).
      environment: ctx.environment ?? 'paper',
      liveEnabled: liveTradingEnabled(),
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
  shortable: found.shortable,
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
  // sessions come fresh with every screen's snapshots. Kept per key and per
  // symbol, so the S&P 500 screen fills part of what the whole market needs.
  const histories = new Map<string, { date: string; at: number; bars: Map<string, ScreenDay[]> }>();
  const historyFor = async (
    client: AlpacaClient,
    keyId: string,
    symbols: string[],
    now: Date,
  ): Promise<{ bars: Map<string, ScreenDay[]>; missed: number }> => {
    const today = nyDate(now);
    const nowMs = now.getTime();
    let entry = histories.get(keyId);
    if (!entry || entry.date !== today || nowMs - entry.at > SCREEN_HISTORY_TTL_MS) {
      entry = { date: today, at: nowMs, bars: new Map() };
      histories.set(keyId, entry);
    }
    const cached = entry.bars;
    const wanted = symbols.filter((s) => !cached.has(s));
    if (wanted.length === 0) return { bars: cached, missed: 0 };
    const fetched = await fetchDailyHistory(client, wanted, addDays(today, -SCREEN_HISTORY_DAYS), {
      sleep: options.sleep,
    });
    for (const s of wanted) {
      // A symbol Alpaca has no bars for is remembered as having none.
      const days = fetched.found.get(s);
      if (days || fetched.missed === 0) cached.set(s, days ?? []);
    }
    return { bars: cached, missed: fetched.missed };
  };
  return {
    needsCredential: true,
    quotes: (ctx) => createAlpacaQuotes(clientFor(ctx), { now: ctx.now }),
    history: (ctx) =>
      createAlpacaHistory(clientFor(ctx), { now: ctx.now, patient: ctx.patient ?? false }),
    check: (ctx) => checkAlpacaData(clientFor(ctx)),
    lookup: async (ctx, symbol) => {
      const found = await lookupAlpacaAsset(clientFor(ctx), symbol);
      return found ? toListing(found) : undefined;
    },
    listings: async (ctx, symbols) => {
      const wanted = new Set(symbols);
      const list = await assetList(clientFor(ctx), ctx.now().getTime());
      return list.filter((a) => wanted.has(a.symbol)).map(toListing);
    },
    search: async (ctx, query) => {
      const list = await assetList(clientFor(ctx), ctx.now().getTime());
      return searchInstruments(list, query).map(toListing);
    },
    watch: async (ctx, symbols) => {
      const snaps = await fetchSnapshots(clientFor(ctx), symbols, { sleep: options.sleep });
      const now = ctx.now();
      const out: WatchPriceResult[] = [];
      for (const [symbol, snap] of snaps.found) {
        const price = watchPriceOf(snap, now);
        if (price) out.push({ symbol, ...price, daily: false, source: 'alpaca-iex' });
      }
      return out;
    },
    screen: async (ctx, request): Promise<ScreenResult> => {
      const client = clientFor(ctx);
      const now = ctx.now();
      const listed = screenUniverse(await assetList(client, now.getTime()));
      const only = request?.symbols;
      const universe = only ? listed.filter((a) => only.has(a.symbol)) : listed;
      const symbols = universe.map((a) => a.symbol);
      const [history, snaps] = await Promise.all([
        historyFor(client, ctx.credential?.fields.keyId ?? '', symbols, now),
        fetchSnapshots(client, symbols, { sleep: options.sleep }),
      ]);
      const warnings = [
        'Alpaca’s free feed has IEX exchange trades only, so volumes are lower than the whole market’s',
      ];
      const missed = Math.max(history.missed, snaps.missed);
      if (missed > 0) {
        warnings.unshift(
          `Alpaca did not answer for about ${missed.toLocaleString('en-US')} of ${symbols.length.toLocaleString('en-US')} stocks; their values are blank. Refresh to try again.`,
        );
      }
      return {
        sources: universe.map((a) =>
          screenSource(a, history.bars.get(a.symbol) ?? [], snaps.found.get(a.symbol)),
        ),
        warnings,
      };
    },
  };
}

/** Alpaca as a trading platform: one account per key, paper or live (ADR 0018, ADR 0109). */
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
          nickname: `Alpaca ${found.environment} ${found.displayId}`,
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

/**
 * A snapshot as a watch list price (N292), split by session (N298).
 *
 * `last` is the regular session's price: the latest trade while the market is
 * open, else the latest regular close (the daily bar, which Alpaca builds from
 * regular-hours trades). It is measured from the close before it. A trade
 * made after that close (after hours, or the next morning before the open)
 * is kept apart as `extLast`, which the page shows only when asked.
 */
export function watchPriceOf(
  snap: AlpacaSnapshot,
  now: Date,
):
  | {
      last: number;
      prevClose: number | null;
      priceAt: Date;
      extLast: number | null;
      extAt: Date | null;
    }
  | undefined {
  const trade = snap.latestTrade;
  const quote = snap.latestQuote;
  const mid = quote && quote.bp > 0 && quote.ap > 0 ? (quote.bp + quote.ap) / 2 : undefined;
  const price = trade && trade.p > 0 ? trade.p : mid;
  const stamp = trade && trade.p > 0 ? trade.t : quote?.t;
  const at = price && stamp ? new Date(stamp) : undefined;
  const daily = snap.dailyBar && snap.dailyBar.c > 0 ? snap.dailyBar : null;

  const session = at ? regularSession(nyDate(at)) : undefined;
  const inRegular =
    !!at &&
    !!session &&
    at.getTime() >= Date.parse(session.open) &&
    at.getTime() < Date.parse(session.close);

  if (price && at && (inRegular || !daily)) {
    // A regular-hours trade (or no daily bar to fall back on).
    let day = nyDate(at);
    if (!inRegular) {
      day = nyDate(now);
      for (let i = 0; i < 10 && !regularSession(day); i++) day = addDays(day, -1);
    }
    const prevClose =
      daily && nyDate(daily.t) >= day ? (snap.prevDailyBar?.c ?? null) : (daily?.c ?? null);
    return { last: price, prevClose, priceAt: at, extLast: null, extAt: null };
  }
  if (!daily) return undefined;
  const closedOn = regularSession(nyDate(daily.t));
  const closeAt = closedOn ? new Date(closedOn.close) : new Date(daily.t);
  const ext = price && at && at.getTime() > closeAt.getTime();
  return {
    last: daily.c,
    prevClose: snap.prevDailyBar?.c ?? null,
    priceAt: closeAt,
    extLast: ext ? price : null,
    extAt: ext ? at : null,
  };
}
