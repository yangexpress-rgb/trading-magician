import type { InstrumentRef } from '@tm/backtest';
import {
  instrumentRefs,
  priceRangeDates,
  savePriceRanges,
  sharedFeedOwner,
  type Database,
} from '@tm/db';
import {
  addDays,
  lastClosedDay,
  nyDate,
  yearRange,
  type Bar,
  type BarRequest,
  type BarSeries,
  type HistoricalDataProvider,
  type RangeDay,
  type YearRange,
} from '@tm/domain';
import type { Logger } from 'pino';

/**
 * The 52-week low and high job (N290, ADR 0099). After each close it works
 * out every registered US stock's and ETF's 52-week low and high, and the
 * trading days since each, from a year of split-adjusted daily bars, and
 * stores them: the screener and Price charts read them. A few batches a
 * pass; once every member is as of the last closed session it waits for the
 * next close. Bars come through the sharing admin's feeds (N237), as the
 * other market-wide jobs' do.
 */

/** Calendar days of daily bars loaded: 252 sessions and the holidays among them, with room. */
export const RANGE_HISTORY_DAYS = 380;
/** Minutes after the close before a day counts, so the feed has its final daily bar. */
const SETTLE_MS = 30 * 60_000;
/** A member whose bars stopped short of the day is tried again after this long. */
const RETRY_MS = 60 * 60_000;

export interface PriceRangePassOptions {
  db: Database;
  history: HistoricalDataProvider;
  /** Instrument ids to keep up to date. */
  members: () => Promise<string[]>;
  now: () => Date;
  logger: Pick<Logger, 'info' | 'warn'>;
  /** Members loaded together (bars come in multi-symbol requests). */
  batchSize?: number;
  /** Stop after this many batches in one pass, so the worker's other jobs get the feed too. */
  maxBatches?: number;
  /**
   * Members tried for a day, with when, and whether that settled the day (bars
   * up to it, but under a year of them): kept by the loop between passes.
   */
  tried?: Map<string, Tried>;
}

export interface Tried {
  day: string;
  at: number;
  /** Nothing more to do for the day; otherwise tried again after an hour. */
  settled: boolean;
}

export interface PriceRangePassResult {
  written: number;
  /** Members still behind the last closed session after this pass. */
  pending: number;
  warnings: string[];
}

/** The last session whose close has settled. */
export const settledDay = (now: Date) => lastClosedDay(now.getTime() - SETTLE_MS);

const barDay = (b: Bar) => nyDate(new Date(Date.parse(b.end) - 1));

/** Plain-number sessions from daily bars, up to and including `lastDay`. */
export function rangeDays(bars: readonly Bar[], lastDay: string): RangeDay[] {
  const out: RangeDay[] = [];
  for (const b of bars) {
    const date = barDay(b);
    if (date > lastDay) continue;
    out.push({ date, high: b.high.toNumber(), low: b.low.toNumber(), close: b.close.toNumber() });
  }
  return out;
}

export async function runPriceRangePass(
  options: PriceRangePassOptions,
): Promise<PriceRangePassResult> {
  const { db } = options;
  const nowMs = options.now().getTime();
  const lastDay = settledDay(options.now());
  const members = [...new Set(await options.members())].sort();
  const stored = await priceRangeDates(db, members);
  const due = members.filter((id) => {
    if ((stored.get(id) ?? '') >= lastDay) return false;
    const t = options.tried?.get(id);
    return !(t && t.day === lastDay && (t.settled || nowMs - t.at < RETRY_MS));
  });
  const result: PriceRangePassResult = { written: 0, pending: due.length, warnings: [] };
  if (due.length === 0) return result;
  const refs = await db.transaction((tx) => instrumentRefs(tx, due));
  const size = options.batchSize ?? 50;
  const from = addDays(lastDay, -RANGE_HISTORY_DAYS);
  let batches = 0;
  for (let i = 0; i < due.length; i += size) {
    if (options.maxBatches !== undefined && batches >= options.maxBatches) break;
    batches++;
    const ids = due.slice(i, i + size).filter((id) => refs.has(id));
    const requests: BarRequest[] = ids.map((id) => {
      const ref = refs.get(id) as InstrumentRef;
      return {
        instrumentId: id,
        symbol: ref.symbol,
        assetClass: ref.assetClass,
        interval: '1d',
        from,
        to: lastDay,
        adjustment: 'split_only',
        session: 'regular',
      };
    });
    const series: (BarSeries | Error)[] = options.history.getBarsMany
      ? await options.history.getBarsMany(requests)
      : await Promise.all(
          requests.map((r) =>
            options.history
              .getBars(r)
              .catch((e: unknown) => (e instanceof Error ? e : new Error(String(e)))),
          ),
        );
    const rows: { instrumentId: string; range: YearRange }[] = [];
    series.forEach((s, k) => {
      const req = requests[k] as BarRequest;
      if (s instanceof Error) {
        options.tried?.set(req.instrumentId, { day: lastDay, at: nowMs, settled: false });
        if (result.warnings.length < 20)
          result.warnings.push(`${req.symbol}: ${s.message.slice(0, 160)}`);
        return;
      }
      const days = rangeDays(s.bars, lastDay);
      // Bars that stop short of the day (not in yet, or halted) are asked for again later.
      const settled = days.at(-1)?.date === lastDay;
      options.tried?.set(req.instrumentId, { day: lastDay, at: nowMs, settled });
      const range = yearRange(days);
      // Under a year of prices (a new listing) has no 52-week figures, as strategies have none.
      if (range) rows.push({ instrumentId: req.instrumentId, range });
    });
    const written = await savePriceRanges(db, rows);
    result.written += written;
    result.pending -= ids.length;
    options.logger.info(
      { members: ids.length, written, day: lastDay, pending: result.pending },
      '52-week ranges written',
    );
  }
  return result;
}

export interface PriceRangeLoop {
  stop(): Promise<void>;
}

const shortError = (e: unknown) =>
  (e instanceof Error ? e.message : 'failed').replace(/\s+/g, ' ').slice(0, 300);

export function startPriceRangeLoop(options: {
  db: Database;
  history: (userId: string) => HistoricalDataProvider;
  members: (userId: string) => Promise<string[]>;
  logger: Pick<Logger, 'info' | 'warn'>;
  now?: () => Date;
  pollMs?: number;
  batchesPerPass?: number;
}): PriceRangeLoop {
  const pollMs = options.pollMs ?? 300_000;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let quietSince = '';
  const tried = new Map<string, Tried>();

  const pass = async () => {
    const owner = await options.db.transaction((tx) => sharedFeedOwner(tx));
    if (!owner) {
      const day = new Date().toISOString().slice(0, 10);
      if (quietSince !== day)
        options.logger.warn({}, '52-week ranges wait: no platform admin shares data feeds');
      quietSince = day;
      return;
    }
    const result = await runPriceRangePass({
      db: options.db,
      history: options.history(owner),
      members: () => options.members(owner),
      now: options.now ?? (() => new Date()),
      logger: options.logger,
      maxBatches: options.batchesPerPass ?? 10,
      tried,
    });
    if (result.warnings.length > 0)
      options.logger.warn(
        { count: result.warnings.length, first: result.warnings.slice(0, 3) },
        '52-week range data warnings',
      );
  };

  const tick = () => {
    if (stopped) return;
    running = pass()
      .catch((e: unknown) =>
        options.logger.warn({ err: shortError(e) }, '52-week range pass failed'),
      )
      .finally(() => {
        running = undefined;
        if (!stopped) timer = setTimeout(tick, pollMs);
      });
  };
  timer = setTimeout(tick, 20_000);
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}
