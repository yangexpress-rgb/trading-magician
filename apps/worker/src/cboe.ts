import { createHash } from 'node:crypto';
import {
  BrokerUnavailableError,
  CBOE_HISTORY_URL,
  cboeBars,
  cboeHistoryPath,
  FRED_CSV_URL,
  fredSeriesQuery,
  indexListingBySymbol,
  parseCboeHistory,
  parseFredSeries,
  UnsupportedBarRequestError,
  type BarSeries,
  type CboeDay,
  type HistoricalDataProvider,
} from '@tm/domain';
import type { MarketDataProvider } from './providers';

/**
 * CBOE end-of-day index history as a price feed (Design v1.2 item 5, ADR 0042):
 * the app's first index feed. CBOE publishes each index's daily history as a
 * free CSV (the VIX's OHLC back to 1990), so the feed needs no key. It gives
 * daily bars only, no intraday bars and no live prices, and it is routed for
 * bars alone. Bars line up with the NYSE calendar (see `cboeBars`), so a back
 * test reads them exactly like any stock's daily bars.
 *
 * When CBOE can't be reached or sends a bad file, the index's FRED series
 * (VIXCLS for the VIX) is used instead: closes only, so flat bars, and the
 * bars say so. Both URLs are configuration (`CBOE_HISTORY_URL`,
 * `FRED_CSV_URL`). The data is Cboe's either way: see `CBOE_DISPLAY_TERMS`.
 */

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface CboeProviderOptions {
  /** Tests only: a fake in place of CBOE's CDN. */
  fetch?: Fetch | undefined;
  /** How long a downloaded history is reused; CBOE updates it once a day. */
  refreshMs?: number | undefined;
  timeoutMs?: number | undefined;
  /** CBOE's history folder; one `<SYMBOL>_History.csv` per index. */
  historyUrl?: string | undefined;
  /** FRED's CSV download, for the fallback series. */
  fredUrl?: string | undefined;
}

interface History {
  days: CboeDay[];
  digest: string;
  /** Where the days came from, and rows refused as malformed or impossible. */
  source: 'cboe' | 'fred';
  skipped: number;
}

const DEFAULTS = { refreshMs: 6 * 3600_000, timeoutMs: 20_000 };
/** A history shorter than this is not the file we expect. */
const MIN_DAYS = 100;

export class CboeUnavailableError extends BrokerUnavailableError {
  constructor(message = 'CBOE index history could not be downloaded') {
    super(message);
    this.name = 'CboeUnavailableError';
  }
}

export function cboeProvider(options: CboeProviderOptions = {}): MarketDataProvider {
  const fetchFn: Fetch = options.fetch ?? ((url, init) => fetch(url, init));
  const refreshMs = options.refreshMs ?? DEFAULTS.refreshMs;
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  // One download per index per process, shared by every tenant: the file is public.
  const historyUrl = (options.historyUrl ?? CBOE_HISTORY_URL).replace(/\/+$/, '');
  const fredUrl = options.fredUrl ?? FRED_CSV_URL;
  const cache = new Map<string, History & { at: number }>();
  const inFlight = new Map<string, Promise<History>>();

  async function get(url: string, who: string, symbol: string): Promise<string> {
    let res: Response;
    try {
      res = await fetchFn(url, {
        headers: { accept: 'text/csv,text/plain', 'user-agent': 'TradingMagician/1.0' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new CboeUnavailableError(`${who} could not be reached for ${symbol}`);
    }
    if (!res.ok) throw new CboeUnavailableError(`${who} answered ${res.status} for ${symbol}`);
    return res.text();
  }

  const digestOf = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

  async function fromCboe(symbol: string): Promise<History> {
    const text = await get(`${historyUrl}${cboeHistoryPath(symbol)}`, 'CBOE', symbol);
    let parsed: ReturnType<typeof parseCboeHistory>;
    try {
      parsed = parseCboeHistory(text);
    } catch {
      throw new CboeUnavailableError(`CBOE's ${symbol} history is not in the expected format`);
    }
    if (parsed.days.length < MIN_DAYS) {
      throw new CboeUnavailableError(`CBOE's ${symbol} history looks incomplete`);
    }
    return { days: parsed.days, digest: digestOf(text), source: 'cboe', skipped: parsed.skipped };
  }

  async function fromFred(symbol: string, series: string): Promise<History> {
    const text = await get(`${fredUrl}${fredSeriesQuery(series)}`, 'FRED', symbol);
    let parsed: ReturnType<typeof parseFredSeries>;
    try {
      parsed = parseFredSeries(text);
    } catch {
      throw new CboeUnavailableError(`FRED's ${series} file is not in the expected format`);
    }
    if (parsed.days.length < MIN_DAYS) {
      throw new CboeUnavailableError(`FRED's ${series} history looks incomplete`);
    }
    return { days: parsed.days, digest: digestOf(text), source: 'fred', skipped: parsed.skipped };
  }

  async function download(symbol: string): Promise<History> {
    try {
      return await fromCboe(symbol);
    } catch (error) {
      const series = indexListingBySymbol(symbol)?.fredSeries;
      if (!series) throw error;
      try {
        return await fromFred(symbol, series);
      } catch {
        throw new CboeUnavailableError(
          `${(error as Error).message}, and its FRED copy (${series}) could not be loaded either`,
        );
      }
    }
  }

  async function history(symbol: string, now: number) {
    const hit = cache.get(symbol);
    if (hit && now - hit.at < refreshMs) return hit;
    let pending = inFlight.get(symbol);
    if (!pending) {
      pending = download(symbol).finally(() => inFlight.delete(symbol));
      inFlight.set(symbol, pending);
    }
    try {
      const fresh = await pending;
      const entry = { at: now, ...fresh };
      cache.set(symbol, entry);
      return entry;
    } catch (error) {
      // A day-old history beats none while CBOE is unreachable.
      if (hit) return hit;
      throw error;
    }
  }

  const historyProvider = (now: () => Date): HistoricalDataProvider => ({
    id: 'cboe-eod',
    intervals: ['1d'],
    async getBars(req): Promise<BarSeries> {
      const listing = indexListingBySymbol(req.symbol);
      if (!listing || listing.provider !== 'cboe') {
        throw new UnsupportedBarRequestError(`CBOE has no index history for ${req.symbol}`);
      }
      if (req.interval !== '1d') {
        throw new UnsupportedBarRequestError(
          `CBOE gives ${req.symbol} as daily bars only, not ${req.interval}`,
        );
      }
      if (req.from > req.to)
        throw new UnsupportedBarRequestError('The start date is after the end date');
      const at = now();
      const h = await history(listing.providerId, at.getTime());
      const { bars, dropped } = cboeBars(h.days, req.from, req.to, at);
      const warnings = [
        `${req.symbol} is CBOE's end-of-day value, aligned to NYSE trading days (${listing.terms.attribution})`,
      ];
      if (h.source === 'fred') {
        warnings.push(
          `CBOE could not be reached, so ${req.symbol} comes from FRED (${listing.fredSeries}): closes only, so each bar's open, high and low are its close`,
        );
      }
      if (h.skipped > 0) {
        warnings.push(
          `${h.skipped} ${h.skipped === 1 ? 'row' : 'rows'} of the ${req.symbol} file ${h.skipped === 1 ? 'was' : 'were'} left out as malformed or impossible (such as a high below the close)`,
        );
      }
      if (dropped.length > 0) {
        warnings.push(
          `${dropped.length} ${req.symbol} value${dropped.length === 1 ? '' : 's'} published on days the NYSE was closed ${dropped.length === 1 ? 'was' : 'were'} left out`,
        );
      }
      return { bars, dataVersion: `${h.source}-${h.digest}`, warnings };
    },
  });

  return {
    needsCredential: false,
    // No live prices: an index feed is routed for bars only (v1.2 item 5).
    quotes: () => ({ id: 'cboe-eod', latestQuote: async () => undefined }),
    history: ({ now }) => historyProvider(now),
    async check({ now }) {
      try {
        await history('VIX', now().getTime());
        return { ok: true, entitlement: 'entitled', realtime: false };
      } catch (error) {
        return {
          ok: false,
          entitlement: 'unknown',
          error: error instanceof Error ? error.message.slice(0, 200) : 'CBOE is not reachable',
        };
      }
    },
  };
}
