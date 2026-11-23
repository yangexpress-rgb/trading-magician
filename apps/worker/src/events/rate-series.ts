import { rateCoverage, saveRateSeries, type Database, type RateCoverageLine } from '@tm/db';
import {
  FRED_CSV_URL,
  fredSeriesQuery,
  parseFredValues,
  RATE_SERIES,
  RATE_SERIES_FROM,
} from '@tm/domain';
import Decimal from 'decimal.js';

/**
 * The market-regime FRED series (data inputs part 2, item A, N322, ADR 0110):
 * investment-grade and high-yield credit spreads, the 10y−2y curve and the
 * 10- and 2-year yields, fetched from the same keyless CSV route as DTB3, one
 * request per series, and kept in rates_daily from RATE_SERIES_FROM (or the
 * series' first published day, whichever is later). FRED revises values: the
 * latest published value replaces the stored one (no vintages, O197).
 */

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface RateSeriesOptions {
  db: Database;
  fredUrl?: string | undefined;
  fetch?: Fetch | undefined;
  logger: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
  now?: () => Date;
  /** How long a fetch stays fresh; FRED publishes once a day. */
  ttlMs?: number;
}

export interface RateSeriesRefresher {
  /** Fetches every series when the last fetch is older than the TTL (or none yet); returns the coverage when it fetched. */
  refresh(): Promise<RateCoverageLine[] | undefined>;
}

const shortError = (e: unknown) =>
  (e instanceof Error ? e.message : 'failed').replace(/\s+/g, ' ').slice(0, 200);

/** FRED's percentage points as a fraction, exactly: 4.98 → 0.0498. */
export const percentToFraction = (value: string) => new Decimal(value).div(100).toNumber();

export function rateSeriesRefresher(o: RateSeriesOptions): RateSeriesRefresher {
  const fetchFn: Fetch = o.fetch ?? ((url, init) => fetch(url, init));
  const baseUrl = o.fredUrl ?? FRED_CSV_URL;
  const ttl = o.ttlMs ?? 6 * 3600_000;
  const now = o.now ?? (() => new Date());
  let fetchedAt: number | undefined;

  return {
    async refresh() {
      const t = now().getTime();
      if (fetchedAt !== undefined && t - fetchedAt < ttl) return undefined;
      fetchedAt = t;
      const failed: string[] = [];
      for (const spec of RATE_SERIES) {
        try {
          const res = await fetchFn(`${baseUrl}${fredSeriesQuery(spec.fred)}`, {
            headers: { accept: 'text/csv', 'user-agent': 'TradingMagician/1.0' },
            signal: AbortSignal.timeout(30_000),
          });
          if (!res.ok) throw new Error(`FRED answered ${res.status}`);
          const parsed = parseFredValues(await res.text());
          if (parsed.days.length === 0) throw new Error(`FRED sent no ${spec.fred} values`);
          const days = parsed.days.map((d) => ({
            date: d.date,
            value: percentToFraction(d.value),
          }));
          const changed = await saveRateSeries(o.db, spec.column, days, RATE_SERIES_FROM);
          o.logger.info(
            { series: spec.fred, published: days.length, changed, skipped: parsed.skipped },
            'FRED series stored',
          );
        } catch (e) {
          failed.push(spec.fred);
          o.logger.warn({ series: spec.fred, err: shortError(e) }, 'FRED series fetch failed');
        }
      }
      // A failed series is tried again on a later pass, not after the full TTL.
      if (failed.length > 0) fetchedAt = t - ttl + 30 * 60_000;
      const coverage = await rateCoverage(o.db);
      o.logger.info(
        {
          series: coverage.map((c) => ({
            series: c.series,
            first: c.first,
            last: c.last,
            days: c.days,
            missingTradingDays: c.missingTradingDays.length,
            bondHolidays: c.bondHolidays,
            firstMissing: c.missingTradingDays.slice(0, 5),
          })),
        },
        'rates coverage',
      );
      return coverage;
    },
  };
}
