import { eq, loadFundamentals, schema, type Database } from '@tm/db';
import {
  FRED_CSV_URL,
  fredSeriesQuery,
  latestObservation,
  parseFredSeries,
  signalAvailableFrom,
  type Bar,
  type HistoricalDataProvider,
  type PriceAdjustment,
} from '@tm/domain';

/**
 * What the pricing package needs besides the chain (options data brief v2
 * §4 preamble): the underlying's daily close from Alpaca (the same close
 * back tests use), the 3-month Treasury bill from FRED (DTB3) as the
 * risk-free rate, and the stock's point-in-time dividend yield from its
 * stored filings (0 for ETFs and unknowns).
 */

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface MarketInputs {
  /** Daily bars of an underlying; empty when the app has no Alpaca key. */
  dailyBars(
    underlying: { id: string; symbol: string; assetClass: string },
    from: string,
    to: string,
    adjustment: PriceAdjustment,
  ): Promise<Bar[]>;
  /** The risk-free rate (a fraction) on a day: DTB3 on or before it; undefined when FRED can't say. */
  riskFreeRate(date: string): Promise<number | undefined>;
  /** Whether closes can be had at all (an Alpaca key is configured). */
  hasCloses: boolean;
}

export interface MarketInputsOptions {
  /** History through the app's own Alpaca key; absent without one. */
  history: HistoricalDataProvider | undefined;
  fredUrl?: string | undefined;
  fetch?: Fetch | undefined;
  /** Tests only: a fixed rate instead of FRED. */
  fixedRate?: number | undefined;
}

const RATE_TTL_MS = 6 * 3600_000;

export function marketInputs(options: MarketInputsOptions): MarketInputs {
  const fetchFn: Fetch = options.fetch ?? ((url, init) => fetch(url, init));
  const fredUrl = options.fredUrl ?? FRED_CSV_URL;
  let rates: { at: number; days: { date: string; rate: number }[] } | undefined;

  async function loadRates() {
    if (rates && Date.now() - rates.at < RATE_TTL_MS) return rates.days;
    try {
      const res = await fetchFn(`${fredUrl}${fredSeriesQuery('DTB3')}`, {
        headers: { accept: 'text/csv', 'user-agent': 'TradingMagician/1.0' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`FRED answered ${res.status}`);
      const parsed = parseFredSeries(await res.text());
      const days = parsed.days
        .map((d) => ({ date: d.date, rate: Number(d.close) / 100 }))
        .filter((d) => Number.isFinite(d.rate));
      if (days.length === 0) throw new Error('FRED sent no DTB3 values');
      rates = { at: Date.now(), days };
    } catch {
      // A day-old series beats none; without any, the day waits (no signal from a guessed rate).
      if (!rates) return undefined;
    }
    return rates.days;
  }

  return {
    hasCloses: options.history !== undefined,
    async dailyBars(u, from, to, adjustment) {
      if (!options.history) return [];
      const series = await options.history.getBars({
        instrumentId: u.id,
        symbol: u.symbol,
        assetClass: u.assetClass,
        interval: '1d',
        from,
        to,
        adjustment,
        session: 'regular',
      });
      return series.bars;
    },
    async riskFreeRate(date) {
      if (options.fixedRate !== undefined) return options.fixedRate;
      const days = await loadRates();
      if (!days) return undefined;
      let found: number | undefined;
      for (const d of days) {
        if (d.date > date) break;
        found = d.rate;
      }
      return found;
    },
  };
}

/**
 * The stock's dividend yield on a day from its stored filings (dividends per
 * share over the last twelve months ÷ the close), as known at that day's
 * close. 0 for ETFs, and for stocks whose filings aren't stored.
 */
export async function dividendYieldOn(
  db: Database,
  underlying: { symbol: string; assetClass: string },
  date: string,
  close: number,
): Promise<number> {
  if (underlying.assetClass !== 'stock' || !(close > 0)) return 0;
  const [company] = await db
    .select({ cik: schema.fundamentalCompanies.cik })
    .from(schema.fundamentalCompanies)
    .where(eq(schema.fundamentalCompanies.symbol, underlying.symbol))
    .limit(1);
  if (!company) return 0;
  const stored = await loadFundamentals(db, [company.cik]);
  const dps = latestObservation(stored.get(company.cik), 'dps_ttm', signalAvailableFrom(date));
  const q = dps ? dps.value.toNumber() / close : 0;
  return Number.isFinite(q) && q >= 0 && q < 1 ? q : 0;
}
