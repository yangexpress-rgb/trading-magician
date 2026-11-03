import { nyDate, type ScreenDay, type ScreenSource } from '@tm/domain';
import { AlpacaUnavailableError, type AlpacaClient } from './client';
import { ALPACA_DATA_FEED } from './endpoints';
import type { DiscoveredInstrument } from './account';
import type { AlpacaBar, AlpacaBarsPage, AlpacaSnapshot } from './types';

/**
 * The stock screener's prices from Alpaca (ADR 0030): one snapshot per
 * symbol (latest trade, today's and yesterday's daily bars) and a month of
 * daily bars, asked for a few hundred symbols at a time.
 */

/** Exchanges whose listings the IEX feed prices; over-the-counter names are left out. */
export const SCREEN_EXCHANGES = new Set(['NYSE', 'NASDAQ', 'ARCA', 'AMEX', 'BATS']);
/** Symbols per request: well inside URL limits and one page of a month's daily bars. */
export const SCREEN_BATCH = 200;
/** Requests in flight at once, so a screen stays well under Alpaca's 200 a minute. */
export const SCREEN_CONCURRENCY = 3;
const RETRIES = 3;
const HOUR = 3_600_000;
const MAX_PAGES = 20;

export interface ScreenFetchOptions {
  /** Waits between retries; tests pass a no-op. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Only the listings a screen covers: tradable stocks and ETFs on the main US exchanges. */
export function screenUniverse(assets: readonly DiscoveredInstrument[]): DiscoveredInstrument[] {
  return assets.filter((a) => a.tradable && SCREEN_EXCHANGES.has(a.venue));
}

export function chunk<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Runs `fn` over `items`, `limit` at a time, keeping the order. */
async function pool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>) {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) {
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Throttled or briefly unreachable: waits and asks again a few times. */
async function retrying<T>(fn: () => Promise<T>, sleep: (ms: number) => Promise<void>) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof AlpacaUnavailableError) || attempt >= RETRIES) throw e;
      await sleep(1000 * 2 ** attempt);
    }
  }
}

const dayOf = (b: AlpacaBar): ScreenDay => ({
  // Daily bars start at midnight New York time; noon is safely inside the day.
  date: nyDate(new Date(Date.parse(b.t) + 12 * HOUR)),
  open: b.o,
  high: b.h,
  low: b.l,
  close: b.c,
  volume: b.v,
});

/** Daily bars from `from` on for every symbol, split-adjusted, oldest first. */
export async function fetchDailyHistory(
  client: AlpacaClient,
  symbols: readonly string[],
  from: string,
  options: ScreenFetchOptions = {},
): Promise<Map<string, ScreenDay[]>> {
  const sleep = options.sleep ?? defaultSleep;
  const out = new Map<string, ScreenDay[]>();
  await pool(chunk(symbols, SCREEN_BATCH), SCREEN_CONCURRENCY, async (batch) => {
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await retrying(
        () =>
          client.data<AlpacaBarsPage>('/v2/stocks/bars', {
            symbols: batch.join(','),
            timeframe: '1Day',
            start: `${from}T00:00:00Z`,
            adjustment: 'split',
            feed: ALPACA_DATA_FEED,
            limit: 10_000,
            sort: 'asc',
            page_token: pageToken,
          }),
        sleep,
      );
      for (const [symbol, bars] of Object.entries(result.bars ?? {})) {
        const list = out.get(symbol) ?? [];
        for (const b of bars ?? []) list.push(dayOf(b));
        out.set(symbol, list);
      }
      if (!result.next_page_token) break;
      pageToken = result.next_page_token;
    }
  });
  return out;
}

/** The latest snapshot of every symbol Alpaca has one for. */
export async function fetchSnapshots(
  client: AlpacaClient,
  symbols: readonly string[],
  options: ScreenFetchOptions = {},
): Promise<Map<string, AlpacaSnapshot>> {
  const sleep = options.sleep ?? defaultSleep;
  const out = new Map<string, AlpacaSnapshot>();
  await pool(chunk(symbols, SCREEN_BATCH), SCREEN_CONCURRENCY, async (batch) => {
    const result = await retrying(
      () =>
        client.data<Record<string, AlpacaSnapshot | null>>('/v2/stocks/snapshots', {
          symbols: batch.join(','),
          feed: ALPACA_DATA_FEED,
        }),
      sleep,
    );
    for (const [symbol, snap] of Object.entries(result ?? {})) {
      if (snap) out.set(symbol, snap);
    }
  });
  return out;
}

/**
 * Puts a symbol's month of daily bars and its snapshot together: the
 * snapshot's daily bars are newer than any cached history, so they win.
 */
export function screenSource(
  asset: DiscoveredInstrument,
  history: readonly ScreenDay[],
  snap: AlpacaSnapshot | undefined,
): ScreenSource {
  const byDate = new Map(history.map((d) => [d.date, d]));
  for (const b of [snap?.prevDailyBar, snap?.dailyBar]) {
    if (b) {
      const d = dayOf(b);
      byDate.set(d.date, d);
    }
  }
  const days = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  const trade = snap?.latestTrade;
  return {
    symbol: asset.symbol,
    name: asset.displayName,
    assetClass: asset.assetClass,
    exchange: asset.venue,
    last: trade && trade.p > 0 ? trade.p : null,
    lastAt: trade ? new Date(trade.t).toISOString() : null,
    days,
  };
}
