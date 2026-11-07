import { createHash } from 'node:crypto';
import {
  nyDate,
  regularSession,
  UnsupportedBarRequestError,
  type Bar,
  type BarInterval,
  type BarRequest,
  type BarSeries,
  type HistoricalDataProvider,
  type LiveQuoteProvider,
  type PriceAdjustment,
  type Quote,
} from '@tm/domain';
import Decimal from 'decimal.js';
import {
  AlpacaAuthError,
  AlpacaRateLimitError,
  AlpacaRequestError,
  AlpacaUnavailableError,
  type AlpacaClient,
} from './client';
import { ALPACA_DATA_FEED } from './endpoints';
import type { AlpacaAccount, AlpacaBar, AlpacaBarsPage, AlpacaSnapshot } from './types';

/**
 * Alpaca market data (ADR 0017): live prices and historical bars from the free
 * IEX feed, behind the same contracts as the demo feed.
 */

export const ALPACA_QUOTE_SOURCE = 'alpaca-iex';

export function isRegularSessionOpen(at: Date): boolean {
  const session = regularSession(nyDate(at));
  if (!session) return false;
  const t = at.getTime();
  return t >= Date.parse(session.open) && t < Date.parse(session.close);
}

const iso = (t: string) => new Date(t).toISOString();
const isNotFound = (e: unknown) =>
  e instanceof AlpacaRequestError && [400, 404, 422].includes(e.status);

export function createAlpacaQuotes(
  client: AlpacaClient,
  options: { now?: () => Date } = {},
): LiveQuoteProvider {
  const now = options.now ?? (() => new Date());
  return {
    id: ALPACA_QUOTE_SOURCE,
    async latestQuote(ref): Promise<Quote | undefined> {
      let snap: AlpacaSnapshot;
      try {
        snap = await client.data<AlpacaSnapshot>(
          `/v2/stocks/${encodeURIComponent(ref.symbol)}/snapshot`,
          { feed: ALPACA_DATA_FEED },
        );
      } catch (e) {
        if (isNotFound(e)) return undefined;
        throw e;
      }
      const trade = snap.latestTrade;
      const quote = snap.latestQuote;
      if (!trade && !quote) return undefined;
      const bid = quote && quote.bp > 0 ? new Decimal(quote.bp) : undefined;
      const ask = quote && quote.ap > 0 ? new Decimal(quote.ap) : undefined;
      const last = trade ? new Decimal(trade.p) : bid && ask ? bid.plus(ask).div(2) : (bid ?? ask);
      if (!last) return undefined;
      const times = [trade?.t, quote?.t].filter((t): t is string => !!t).map(iso);
      const at = times.sort().at(-1);
      if (!at) return undefined;
      const quoted = quote ? Math.min(quote.as, quote.bs) : 0;
      const size = new Decimal(quoted > 0 ? quoted : (trade?.s ?? 1));
      const received = now();
      return {
        instrumentId: ref.instrumentId,
        symbol: ref.symbol,
        bid: bid ?? last,
        ask: ask ?? last,
        last,
        size,
        at,
        receivedAt: received.toISOString(),
        source: ALPACA_QUOTE_SOURCE,
        marketOpen: isRegularSessionOpen(received),
      };
    },
  };
}

export interface AlpacaCheckResult {
  ok: boolean;
  entitlement: 'entitled' | 'not_entitled' | 'unknown';
  realtime: boolean;
  error?: string;
}

/**
 * A light check of a key for market data: the paper account answers and is
 * active, and the data API accepts the key. IEX data is included with every
 * Alpaca account, so a working key is entitled to it.
 */
export async function checkAlpacaData(client: AlpacaClient): Promise<AlpacaCheckResult> {
  try {
    const account = await client.trading<AlpacaAccount>('GET', '/v2/account');
    if (account.status !== 'ACTIVE') {
      return {
        ok: false,
        entitlement: 'unknown',
        realtime: true,
        error: 'The Alpaca account is not active.',
      };
    }
    await client.data('/v2/stocks/meta/exchanges');
    return { ok: true, entitlement: 'entitled', realtime: true };
  } catch (e) {
    if (e instanceof AlpacaAuthError) {
      return {
        ok: false,
        entitlement: 'not_entitled',
        realtime: true,
        error: 'Alpaca refused the API key. Replace it under Stored API keys.',
      };
    }
    if (e instanceof AlpacaRequestError && e.status === 403) {
      return {
        ok: false,
        entitlement: 'not_entitled',
        realtime: true,
        error: 'This Alpaca key cannot read market data.',
      };
    }
    return { ok: false, entitlement: 'unknown', realtime: true, error: 'Alpaca is not reachable.' };
  }
}

const TIMEFRAMES: Partial<Record<BarInterval, string>> = {
  '5m': '5Min',
  '1h': '1Hour',
  '1d': '1Day',
};
const STEP_MS: Partial<Record<BarInterval, number>> = { '5m': 5 * 60_000, '1h': 3_600_000 };
const ADJUSTMENTS: Record<PriceAdjustment, string> = {
  none: 'raw',
  split_only: 'split',
  split_and_dividend: 'all',
};
const HOUR = 3_600_000;
const MAX_PAGES = 200;

/**
 * Asks again when Alpaca throttles (waiting as long as it says, else 2 s, 4 s,
 * 8 s…) or is briefly unreachable, so a back test over hundreds of symbols
 * slows down to the key's limit instead of failing (v1.2 review).
 */
export async function withAlpacaRetries<T>(
  fn: () => Promise<T>,
  sleep: (ms: number) => Promise<void>,
  attempts = 8,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const limited = e instanceof AlpacaRateLimitError;
      const unavailable = e instanceof AlpacaUnavailableError && !(e instanceof AlpacaAuthError);
      if (!unavailable || attempt >= (limited ? attempts : 3) - 1) throw e;
      const backoff = 2000 * 2 ** Math.min(attempt, 4);
      const wait = limited && e.retryAfterMs !== undefined ? e.retryAfterMs + 250 : backoff;
      await sleep(Math.min(wait, 65_000));
    }
  }
}

export function createAlpacaHistory(
  client: AlpacaClient,
  options: {
    now?: () => Date;
    /** Wait out throttling and brief outages (back tests); otherwise fail at once. */
    patient?: boolean;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): HistoricalDataProvider {
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const call = <T>(fn: () => Promise<T>) => (options.patient ? withAlpacaRetries(fn, sleep) : fn());
  return {
    id: 'alpaca-iex',
    intervals: ['5m', '1h', '1d'],
    async getBars(req: BarRequest): Promise<BarSeries> {
      const timeframe = TIMEFRAMES[req.interval];
      if (!timeframe) {
        throw new UnsupportedBarRequestError(
          `Alpaca bars here are daily, hourly or 5-minute, not ${req.interval}`,
        );
      }
      if (req.from > req.to)
        throw new UnsupportedBarRequestError('The start date is after the end date');
      const warnings = ['Alpaca’s free feed has IEX exchange trades only, so volumes are lower'];
      if (req.interval === '1h') {
        warnings.push('Hourly bars follow clock hours; the first one each day covers 9:30–10:00');
      }
      if (req.session === 'extended') {
        warnings.push('Alpaca bars here cover the regular session only');
      }

      const raw: AlpacaBar[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        let result: AlpacaBarsPage;
        try {
          const token = pageToken;
          result = await call(() =>
            client.data<AlpacaBarsPage>('/v2/stocks/bars', {
              symbols: req.symbol,
              timeframe,
              start: `${req.from}T00:00:00Z`,
              end: new Date(Date.parse(`${req.to}T00:00:00Z`) + 2 * 86_400_000).toISOString(),
              adjustment: ADJUSTMENTS[req.adjustment],
              feed: ALPACA_DATA_FEED,
              limit: 10_000,
              sort: 'asc',
              page_token: token,
            }),
          );
        } catch (e) {
          if (isNotFound(e)) {
            throw new UnsupportedBarRequestError(`Alpaca has no bars for ${req.symbol}`);
          }
          throw e;
        }
        raw.push(...(result.bars[req.symbol] ?? []));
        if (!result.next_page_token) break;
        pageToken = result.next_page_token;
      }

      const cutoff = now().getTime();
      const bars: Bar[] = [];
      for (const b of raw) {
        const start = Date.parse(b.t);
        const date = nyDate(new Date(req.interval === '1d' ? start + 12 * HOUR : start));
        if (date < req.from || date > req.to) continue;
        const session = regularSession(date);
        if (!session) continue;
        const open = Date.parse(session.open);
        const close = Date.parse(session.close);
        let from: number;
        let to: number;
        if (req.interval === '1d') {
          from = open;
          to = close;
        } else {
          from = Math.max(start, open);
          to = Math.min(start + (STEP_MS[req.interval] ?? HOUR), close);
          if (from >= to) continue;
        }
        if (to > cutoff) continue;
        bars.push({
          start: new Date(from).toISOString(),
          end: new Date(to).toISOString(),
          open: new Decimal(b.o),
          high: new Decimal(b.h),
          low: new Decimal(b.l),
          close: new Decimal(b.c),
          volume: new Decimal(b.v),
        });
      }
      const digest = createHash('sha256')
        .update(JSON.stringify([req.symbol, req.interval, req.adjustment, raw]))
        .digest('hex')
        .slice(0, 16);
      return { bars, dataVersion: `${ALPACA_QUOTE_SOURCE}-${digest}`, warnings };
    },
  };
}
