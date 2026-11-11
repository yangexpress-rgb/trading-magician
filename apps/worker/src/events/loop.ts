import {
  getScanState,
  mergeDuplicateDeals,
  saveCalendar,
  setScanState,
  type Database,
} from '@tm/db';
import { addDays, EVENT_HISTORY_FROM, nyDate, zonedWallTimeToIso } from '@tm/domain';
import type { SecClient, SecListing } from '@tm/sec';
import type { Logger } from 'pino';
import { fetchCalendar, type CalendarSource } from './calendar';
import { refreshDealCloses, type DailyBars } from './deal-closes';
import { scanDeals, updateDealStatuses } from './deals-tracker';
import { runEarningsBackfill, runEarningsScan } from './earnings-scan';

/**
 * The event jobs (free data feeds brief v1 §5, ADR 0058), one worker loop:
 * once, the history rebuild of earnings and deals back to February 2024;
 * then each evening after the close, the release scan, the deal tracker and
 * its status re-check, the calendar refresh and the T-bill rate. A failing
 * job is logged and retried on a later pass; it never stops the others or
 * the options recording.
 */

export interface EventsLoopOptions {
  db: Database;
  /** Without an SEC contact the EDGAR jobs wait (logged once a day). */
  client: SecClient | undefined;
  tickers: (client: SecClient) => Promise<Map<string, SecListing>>;
  /**
   * Calendar sources in order (FMP, then Finnhub), resolved each night so a
   * newly added key is used without a restart; empty is EDGAR-only mode.
   */
  calendar: () => Promise<readonly CalendarSource[]>;
  /**
   * Daily bars through the app's Alpaca key (the options recording's), for
   * the deal targets' closes (N151); absent without a key.
   */
  dealBars?: DailyBars | undefined;
  /** Fetches DTB3 through the options market inputs, which store it in rates_daily. */
  refreshRates: (today: string) => Promise<unknown>;
  logger: Pick<Logger, 'info' | 'warn'>;
  now?: () => Date;
  pollMs?: number;
  /** Tests only: the scan's symbols instead of the S&P 500 and strategy stocks. */
  symbols?: readonly string[];
}

/** The evening jobs start at 18:30 New York, after most results 8-Ks are filed. */
export const EVENTS_AFTER = '18:30';
/** The daily scans re-read this many days, for filings EDGAR dated late. */
const OVERLAP_DAYS = 3;

const shortError = (e: unknown) =>
  (e instanceof Error ? e.message : 'failed').replace(/\s+/g, ' ').slice(0, 200);

/**
 * Whether the deal closes are due (N151): once a day, and again after the
 * evening close so the list shows that day's close; a failed run is retried
 * after an hour.
 */
export function dealClosesDue(
  state: { status: string; lastRunAt: Date | null } | undefined,
  now: Date,
): boolean {
  const last = state?.lastRunAt;
  if (!last) return true;
  if (state.status === 'failed' || state.status === 'running')
    return now.getTime() - last.getTime() >= 3600_000;
  if (nyDate(last) !== nyDate(now)) return true;
  return eveningDue(now) && !eveningDue(last);
}

export function eveningDue(now: Date): boolean {
  const today = nyDate(now);
  const from = zonedWallTimeToIso(`${today}T${EVENTS_AFTER}:00`, 'America/New_York');
  return !!from && now.getTime() >= Date.parse(from);
}

/** One pass: whatever is due runs, each step on its own. */
export async function runEventsPass(o: EventsLoopOptions): Promise<void> {
  const now = (o.now ?? (() => new Date()))();
  const today = nyDate(now);
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      o.logger.warn({ job: name, err: shortError(e) }, 'event job failed');
    }
  };
  const client = o.client;
  if (!client) {
    for (const job of ['earnings_scan', 'deals_scan'] as const) {
      const s = await getScanState(o.db, job);
      if (s?.status !== 'skipped' || nyDate(s.lastRunAt ?? new Date(0)) !== today) {
        await setScanState(o.db, job, {
          status: 'skipped',
          lastRunAt: now,
          note: 'No SEC contact: set SEC_CONTACT_EMAIL or add an SEC EDGAR feed as a platform admin',
        });
        o.logger.warn({ job }, 'EDGAR event jobs wait for an SEC contact');
      }
    }
  } else {
    const base = { db: o.db, client, logger: o.logger, now: () => now };
    const opts = {
      ...base,
      tickers: () => o.tickers(client),
      ...(o.symbols ? { symbols: o.symbols } : {}),
    };
    // The one-off history rebuild, earnings first (P0), then deals (P1).
    const er = await getScanState(o.db, 'earnings_rebuild');
    if (er?.status !== 'done')
      await step('earnings_rebuild', () =>
        runEarningsScan(opts, 'earnings_rebuild', EVENT_HISTORY_FROM),
      );
    // Stocks that joined the scan since then get their history, once a day.
    const eb = await getScanState(o.db, 'earnings_backfill');
    if (er?.status === 'done' && eb?.coveredTo !== today)
      await step('earnings_backfill', () => runEarningsBackfill(opts, EVENT_HISTORY_FROM));
    const dr = await getScanState(o.db, 'deals_rebuild');
    if (dr?.status !== 'done') {
      // A rebuild stopped part-way resumes after the last month it finished.
      const resume = dr?.coveredTo ? addDays(dr.coveredTo, 1) : EVENT_HISTORY_FROM;
      await step('deals_rebuild', async () => {
        if (resume <= today) await scanDeals(opts, 'deals_rebuild', resume, today);
        await setScanState(o.db, 'deals_rebuild', {
          status: 'done',
          coveredFrom: EVENT_HISTORY_FROM,
          coveredTo: today,
        });
      });
      await step('deal_status', () => updateDealStatuses(opts, 10_000));
    }
    if (eveningDue(now)) {
      const es = await getScanState(o.db, 'earnings_scan');
      if (es?.coveredTo !== today) {
        const from = addDays(es?.coveredTo ?? today, -OVERLAP_DAYS);
        await step('earnings_scan', () => runEarningsScan(opts, 'earnings_scan', from));
      }
      const ds = await getScanState(o.db, 'deals_scan');
      if (ds?.coveredTo !== today) {
        const from = addDays(ds?.coveredTo ?? today, -OVERLAP_DAYS);
        await step('deals_scan', () => scanDeals(opts, 'deals_scan', from, today));
        await step('deal_status', () => updateDealStatuses(opts));
      }
    }
  }
  // One deal, several filings (N152): fold rows that repeat a deal into one.
  await step('deals_dedupe', async () => {
    const merged = await mergeDuplicateDeals(o.db);
    if (merged.length > 0) o.logger.info({ merged }, 'duplicate deals merged');
  });
  if (dealClosesDue(await getScanState(o.db, 'deal_closes'), now))
    await step('deal_closes', async () => {
      try {
        await refreshDealCloses({ db: o.db, bars: o.dealBars, logger: o.logger, now });
      } catch (e) {
        await setScanState(o.db, 'deal_closes', { status: 'failed', lastError: shortError(e) });
        throw e;
      }
    });
  if (eveningDue(now)) {
    const cs = await getScanState(o.db, 'calendar');
    if (cs?.coveredFrom !== today) {
      const sources = await o.calendar().catch(() => []);
      if (sources.length === 0) {
        await setScanState(o.db, 'calendar', {
          status: 'skipped',
          coveredFrom: today,
          lastRunAt: now,
          note: 'EDGAR-only mode: no calendar key, or EARNINGS_CALENDAR_PROVIDER is none',
        });
      } else
        await step('calendar', async () => {
          await setScanState(o.db, 'calendar', { status: 'running', lastRunAt: now });
          try {
            const got = await fetchCalendar(sources, today);
            await saveCalendar(o.db, got.provider, got.rows, now);
            await setScanState(o.db, 'calendar', {
              status: 'done',
              coveredFrom: today,
              coveredTo: addDays(today, 89),
              lastOkAt: now,
              lastError: null,
              note: `${got.rows.length} scheduled releases from ${got.provider}`,
            });
          } catch (e) {
            // Stay in EDGAR-only mode for the day; never crash the worker.
            await setScanState(o.db, 'calendar', {
              status: 'failed',
              coveredFrom: today,
              lastError: shortError(e),
            });
            throw e;
          }
        });
    }
    await step('rates', () => o.refreshRates(today));
  }
}

export interface EventsLoop {
  stop: () => Promise<void>;
}

export function startEventsLoop(o: EventsLoopOptions): EventsLoop {
  const pollMs = o.pollMs ?? 5 * 60_000;
  let running = true;
  let wake: (() => void) | undefined;
  const done = (async () => {
    while (running) {
      try {
        await runEventsPass(o);
      } catch (e) {
        o.logger.warn({ err: shortError(e) }, 'events loop failed');
      }
      if (!running) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, pollMs);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  })();
  return {
    stop: async () => {
      running = false;
      wake?.();
      await done;
    },
  };
}
