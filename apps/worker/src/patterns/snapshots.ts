import { MarketView, seriesKey, type InstrumentRef } from '@tm/backtest';
import {
  instrumentRefs,
  latestSnapshotDates,
  loadEventData,
  loadOptionSignals,
  saveFactorSnapshots,
  type Database,
  type FactorSnapshotInput,
} from '@tm/db';
import {
  addDays,
  barRatios,
  computeDailyFactors,
  FACTOR_CATALOGUE_V1,
  FACTOR_CATALOGUE_VERSION,
  FilingIndex,
  isEventMetricId,
  lastClosedDay,
  nextTradingDay,
  nyDate,
  regularSession,
  sessionFactors,
  SNAPSHOT_WARMUP_CALENDAR_DAYS,
  withFilingIndex,
  type Bar,
  type BarRequest,
  type BarSeries,
  type FactorValues,
  type FundamentalObservation,
  type HistoricalDataProvider,
  type PriceAdjustment,
} from '@tm/domain';
import type { FundamentalsLoader } from '../fundamentals';

/**
 * Pattern discovery's factor snapshot job (pattern brief §3, N261, ADR 0091).
 * For every member of the app's stock groups and the options universe it
 * writes one row per trading day: the factor catalogue's raw values as of
 * that day's close, through the back test's own market view (the same bars,
 * filings as filed, events and options signals a strategy condition reads),
 * plus the day's bar as ratios to the previous close. First it backfills
 * each member from PATTERN_SNAPSHOT_FROM; afterwards each pass adds the days
 * that have closed since. Rows are insert-only: a stored day is never redone.
 */

export interface PatternSnapshotOptions {
  db: Database;
  /** Daily and 5-minute bars, through the sharing admin's feeds. */
  history: HistoricalDataProvider;
  fundamentals: FundamentalsLoader;
  /** Every snapshot member (stock groups ∪ options universe), by instrument id. */
  members: () => Promise<string[]>;
  /** The options universe's instrument ids: the session factors are worked out for these (§4). */
  sessionMembers: () => Promise<string[]>;
  userId: string;
  now: () => Date;
  /** The first snapshot day of a backfill. */
  from: string;
  logger: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
  /** Members loaded together (bars come in multi-symbol requests). */
  batchSize?: number;
  /** Stop after this many batches in one pass, so a long backfill yields. */
  maxBatches?: number;
  onProgress?: () => Promise<void>;
  /**
   * Members already tried for a last day, by id: one whose bars stop short of
   * it (no history, halted, delisted) is tried again only once a new day has
   * closed, not every pass. The loop keeps one map for its lifetime.
   */
  attempts?: Map<string, string>;
}

export interface PatternSnapshotResult {
  rows: number;
  members: number;
  /** Members still behind the last closed day after this pass. */
  pending: number;
  warnings: string[];
}

const DAILY_ADJUSTMENTS: readonly PriceAdjustment[] = ['split_and_dividend', 'none', 'split_only'];

const closeOf = (date: string) => Date.parse(regularSession(date)?.close ?? `${date}T21:00:00Z`);
const barDate = (b: Bar) => nyDate(new Date(Date.parse(b.end) - 1));

/** The last trading day whose close has passed and whose evening scans have had a night. */
export function lastSnapshotDay(now: Date): string {
  const nowMs = now.getTime();
  const today = regularSession(nyDate(now));
  // Before today's open, yesterday's evening filings and events scans are in.
  return lastClosedDay(today ? Math.min(nowMs, Date.parse(today.open)) : nowMs);
}

/** One pass: the members behind the last day, batch by batch, oldest need first. */
export async function runPatternSnapshotPass(
  options: PatternSnapshotOptions,
): Promise<PatternSnapshotResult> {
  const { db } = options;
  const lastDay = lastSnapshotDay(options.now());
  const members = [...new Set(await options.members())].sort();
  const sessionSet = new Set(await options.sessionMembers());
  const latest = await latestSnapshotDates(db, members);
  const need = new Map<string, string>();
  for (const id of members) {
    const last = latest.get(id);
    const next = last ? nextTradingDay(last) : options.from;
    if (next <= lastDay && options.attempts?.get(id) !== lastDay) need.set(id, next);
  }
  const result: PatternSnapshotResult = {
    rows: 0,
    members: 0,
    pending: need.size,
    warnings: [],
  };
  if (need.size === 0) return result;
  const refs = await db.transaction((tx) => instrumentRefs(tx, [...need.keys()]));
  // Backfills (earliest need) first; members with the same need load together.
  const queue = [...need]
    .filter(([id]) => refs.has(id))
    .sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]));
  const size = options.batchSize ?? 25;
  let batches = 0;
  for (let i = 0; i < queue.length; i += size) {
    if (options.maxBatches !== undefined && batches >= options.maxBatches) break;
    batches++;
    const batch = queue.slice(i, i + size);
    const done = await snapshotBatch(options, batch, refs, sessionSet, lastDay);
    for (const [id] of batch) options.attempts?.set(id, lastDay);
    result.rows += done.rows;
    result.members += batch.length;
    result.pending -= batch.length;
    for (const w of done.warnings) if (result.warnings.length < 20) result.warnings.push(w);
    options.logger.info(
      {
        members: batch.length,
        from: batch[0]?.[1],
        to: lastDay,
        rows: done.rows,
        pending: result.pending,
      },
      'pattern snapshots written',
    );
    await options.onProgress?.();
  }
  return result;
}

/** Daily bars of every member in a batch, in as few requests as the feed allows. */
async function loadDailyBars(
  history: HistoricalDataProvider,
  ids: readonly string[],
  refs: ReadonlyMap<string, InstrumentRef>,
  from: string,
  to: string,
): Promise<{ series: Map<string, Bar[]>; warnings: string[] }> {
  const requests: BarRequest[] = [];
  for (const id of ids) {
    const ref = refs.get(id) as InstrumentRef;
    for (const adjustment of DAILY_ADJUSTMENTS)
      requests.push({
        instrumentId: id,
        symbol: ref.symbol,
        assetClass: ref.assetClass,
        interval: '1d',
        from,
        to,
        adjustment,
        session: 'regular',
      });
  }
  const results: (BarSeries | Error)[] = history.getBarsMany
    ? await history.getBarsMany(requests)
    : await Promise.all(
        requests.map((r) =>
          history.getBars(r).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e)))),
        ),
      );
  const series = new Map<string, Bar[]>();
  const warnings = new Set<string>();
  results.forEach((r, k) => {
    const req = requests[k] as BarRequest;
    if (r instanceof Error) {
      warnings.add(`${req.symbol}: ${r.message.slice(0, 160)}`);
      return;
    }
    series.set(seriesKey(req), r.bars);
  });
  return { series, warnings: [...warnings] };
}

/** One member's session factors per day from `from` to `to`, a year of 5-minute bars at a time. */
async function loadSessionFactors(
  history: HistoricalDataProvider,
  ref: InstrumentRef & { id: string },
  from: string,
  to: string,
  warnings: string[],
): Promise<Map<string, FactorValues>> {
  const out = new Map<string, FactorValues>();
  for (let start = from; start <= to; start = addDays(start, 366)) {
    const end = addDays(start, 365) < to ? addDays(start, 365) : to;
    let bars: Bar[];
    try {
      bars = (
        await history.getBars({
          instrumentId: ref.id,
          symbol: ref.symbol,
          assetClass: ref.assetClass,
          interval: '5m',
          from: start,
          to: end,
          adjustment: 'split_and_dividend',
          session: 'regular',
        })
      ).bars;
    } catch (e) {
      warnings.push(
        `${ref.symbol} 5-minute bars: ${(e instanceof Error ? e.message : 'failed').slice(0, 160)}`,
      );
      continue;
    }
    const byDay = new Map<string, Bar[]>();
    for (const b of bars) {
      const d = nyDate(b.start);
      const list = byDay.get(d) ?? [];
      list.push(b);
      byDay.set(d, list);
    }
    for (const [d, list] of byDay) {
      const v = sessionFactors(d, list);
      if (Object.keys(v).length > 0) out.set(d, v);
    }
  }
  return out;
}

async function snapshotBatch(
  options: PatternSnapshotOptions,
  batch: readonly (readonly [string, string])[],
  refs: ReadonlyMap<string, InstrumentRef>,
  sessionSet: ReadonlySet<string>,
  lastDay: string,
): Promise<{ rows: number; warnings: string[] }> {
  const ids = batch.map(([id]) => id);
  const needOf = new Map(batch);
  const earliest = batch.map(([, d]) => d).sort()[0] as string;
  const loadFrom = addDays(earliest, -SNAPSHOT_WARMUP_CALENDAR_DAYS);
  const { series, warnings } = await loadDailyBars(options.history, ids, refs, loadFrom, lastDay);
  await options.onProgress?.();

  // Filings (stocks only), events and options signals, as a back test loads them.
  const stocks = ids.filter((id) => refs.get(id)?.assetClass === 'stock');
  let filings = new Map<string, FundamentalObservation[]>();
  if (stocks.length > 0) {
    const loaded = await options.fundamentals(
      options.userId,
      stocks.map((id) => ({ id, symbol: refs.get(id)?.symbol ?? '' })),
      {
        perSymbolWarnings: false,
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      },
    );
    filings = loaded.byId;
  }
  const eventMetrics = new Set(
    FACTOR_CATALOGUE_V1.flatMap((f) =>
      f.metric && isEventMetricId(f.metric.metric) ? [f.metric.metric] : [],
    ),
  );
  const events = await loadEventData(
    options.db,
    new Map(ids.map((id) => [id, eventMetrics as ReadonlySet<string>])),
  );
  const optionSignals = await loadOptionSignals(options.db, ids, addDays(loadFrom, -10));
  const view = new MarketView(series, new Set(), filings, optionSignals, events);
  const indexes = new Map([...filings].map(([id, list]) => [id, new FilingIndex(list)]));

  // Plain-number adjusted bars per member, and where each day sits in them.
  const plain = new Map<
    string,
    { close: number[]; high: number[]; low: number[]; volume: number[]; at: Map<string, number> }
  >();
  const days = new Set<string>();
  for (const id of ids) {
    const bars = series.get(`${id}|1d|split_and_dividend|regular`) ?? [];
    const p = {
      close: [] as number[],
      high: [] as number[],
      low: [] as number[],
      volume: [] as number[],
      at: new Map<string, number>(),
    };
    for (const b of bars) {
      const d = barDate(b);
      p.at.set(d, p.close.length);
      p.close.push(b.close.toNumber());
      p.high.push(b.high.toNumber());
      p.low.push(b.low.toNumber());
      p.volume.push(b.volume.toNumber());
      if (d >= (needOf.get(id) as string) && d <= lastDay) days.add(d);
    }
    plain.set(id, p);
  }

  // Session factors for the options universe's members in the batch.
  const session = new Map<string, Map<string, FactorValues>>();
  for (const id of ids) {
    if (!sessionSet.has(id)) continue;
    const ref = refs.get(id) as InstrumentRef;
    session.set(
      id,
      await loadSessionFactors(
        options.history,
        { ...ref, id },
        needOf.get(id) as string,
        lastDay,
        warnings,
      ),
    );
    await options.onProgress?.();
  }

  const rows: FactorSnapshotInput[] = [];
  let nowMs = 0;
  const readers = new Map(
    ids.map((id) => [id, withFilingIndex(view, id, indexes.get(id), () => nowMs)]),
  );
  let written = 0;
  for (const date of [...days].sort()) {
    nowMs = closeOf(date);
    view.advance(nowMs);
    for (const id of ids) {
      if (date < (needOf.get(id) as string)) continue;
      const p = plain.get(id);
      const at = p?.at.get(date);
      if (!p || at === undefined) continue;
      const values = computeDailyFactors(
        id,
        readers.get(id) as ReturnType<typeof withFilingIndex>,
        { close: p.close, volume: p.volume, at },
        indexes.get(id),
        nowMs,
      );
      Object.assign(values, session.get(id)?.get(date) ?? {});
      const ratios = barRatios(p.close[at - 1], {
        close: p.close[at] as number,
        high: p.high[at] as number,
        low: p.low[at] as number,
      });
      rows.push({
        instrumentId: id,
        asOf: date,
        values,
        closeRet: ratios?.closeRet ?? null,
        highRel: ratios?.highRel ?? null,
        lowRel: ratios?.lowRel ?? null,
      });
    }
    // Write as we go so a long backfill doesn't hold every row in memory.
    if (rows.length >= 5000) {
      written += await saveFactorSnapshots(options.db, rows.splice(0), FACTOR_CATALOGUE_VERSION);
      await options.onProgress?.();
    }
  }
  written += await saveFactorSnapshots(options.db, rows, FACTOR_CATALOGUE_VERSION);
  return { rows: written, warnings };
}
