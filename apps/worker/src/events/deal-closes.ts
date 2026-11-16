import { dealCloseSymbols, saveDealClose, setScanState, type Database } from '@tm/db';
import { addDays, nyDate, type Bar } from '@tm/domain';
import type { Logger } from 'pino';

/**
 * The Deals list's closes (N151): each deal target's latest daily close from
 * Alpaca bars, the same closes back tests read for `deals.spread_pct`, not
 * the options recording (which covers only its own underlyings). Stored on
 * the deal so the web app, which cannot open the bars route, can show the
 * close and the spread. A target with no bars keeps no close: never a zero.
 */

/** Daily bars of a US stock from `from` to `to` (New York dates, inclusive). */
export type DailyBars = (symbol: string, from: string, to: string) => Promise<readonly Bar[]>;

export interface DealClosesOptions {
  db: Database;
  bars: DailyBars | undefined;
  logger: Pick<Logger, 'info' | 'warn'>;
  now: Date;
  /**
   * The most the run may wait on bars (N288). The bars come from a key the
   * running strategies share, and its background requests wait while they
   * use the minute; without a limit one run held the whole events loop, the
   * earnings calendar included, from Nov 14 to Nov 16 2026.
   */
  deadlineMs?: number;
}

/** Default time limit for one run of the deal closes. */
export const DEAL_CLOSES_DEADLINE_MS = 10 * 60_000;

export class DealClosesTimeout extends Error {
  constructor(minutes: number) {
    super(`Stopped after ${minutes} minutes waiting for Alpaca bars (the shared key is busy)`);
    this.name = 'DealClosesTimeout';
  }
}

/** Enough calendar days back to span a long weekend and a holiday. */
const LOOKBACK_DAYS = 10;

const shortError = (e: unknown) =>
  (e instanceof Error ? e.message : 'failed').replace(/\s+/g, ' ').slice(0, 200);

/** The latest completed bar's close and New York date, or undefined. */
export function latestClose(
  bars: readonly Bar[],
  now: Date,
): { close: number; date: string } | undefined {
  for (let i = bars.length - 1; i >= 0; i--) {
    const b = bars[i] as Bar;
    if (Date.parse(b.end) > now.getTime()) continue;
    const close = Number(b.close.toString());
    if (!(close > 0)) continue;
    return { close, date: nyDate(new Date(b.start)) };
  }
  return undefined;
}

export async function refreshDealCloses(o: DealClosesOptions) {
  const today = nyDate(o.now);
  await setScanState(o.db, 'deal_closes', { status: 'running', lastRunAt: o.now });
  if (!o.bars) {
    await setScanState(o.db, 'deal_closes', {
      status: 'skipped',
      note: 'No Alpaca key for daily closes: set OPTIONS_ALPACA_KEY_ID or add an Alpaca feed as a platform admin',
    });
    return { stored: 0, none: 0, failed: 0 };
  }
  const counts = { stored: 0, none: 0, failed: 0 };
  const limitMs = o.deadlineMs ?? DEAL_CLOSES_DEADLINE_MS;
  const deadline = Date.now() + limitMs;
  const bars = o.bars;
  const timeout = () => new DealClosesTimeout(Math.round(limitMs / 60_000));
  // Each request races what is left of the run; one that loses is left to finish on its own.
  const barsBefore = (symbol: string) => {
    const left = deadline - Date.now();
    if (left <= 0) return Promise.reject(timeout());
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      bars(symbol, addDays(today, -LOOKBACK_DAYS), today),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(timeout()), left);
      }),
    ]).finally(() => clearTimeout(timer));
  };
  for (const symbol of await dealCloseSymbols(o.db)) {
    try {
      const last = latestClose(await barsBefore(symbol), o.now);
      if (!last) {
        counts.none++;
        continue;
      }
      await saveDealClose(o.db, symbol, last.close, last.date);
      counts.stored++;
    } catch (e) {
      // Out of time: the run stops here and the loop moves on; it retries in an hour.
      if (e instanceof DealClosesTimeout) throw e;
      counts.failed++;
      o.logger.warn({ symbol, err: shortError(e) }, 'deal target close unavailable');
    }
  }
  await setScanState(o.db, 'deal_closes', {
    status: 'done',
    coveredTo: today,
    lastOkAt: new Date(),
    lastError: counts.failed > 0 ? `${counts.failed} targets' bars could not be loaded` : null,
    note: `${counts.stored} closes stored, ${counts.none} targets without bars`,
  });
  o.logger.info({ job: 'deal_closes', ...counts }, 'deal closes refreshed');
  return counts;
}
