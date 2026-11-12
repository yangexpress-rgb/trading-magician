import { loadData, MarketView, planExprs, type InstrumentRef } from '@tm/backtest';
import {
  instrumentRefs,
  listMlModelRows,
  loadEventData,
  saveAvailability,
  saveLabels,
  saveSnapshots,
  snapshotRaw,
  snapshotState,
  type Database,
  type LabelRow,
  type MlModelRow,
  type SnapshotRow,
} from '@tm/db';
import {
  computeFeatures,
  dailyClose,
  FEATURE_SET_V1,
  featureAvailability,
  HIGH_WINDOW,
  LABEL_HORIZON_DAYS,
  lastClosedDay,
  metricRequirements,
  nyDate,
  predictionDates,
  regularSession,
  tradingDayAfter,
  transformCrossSection,
  type DailySeries,
  type FeatureSpec,
  type FeatureValues,
  type HistoricalDataProvider,
} from '@tm/domain';
import type { FundamentalsLoader } from '../fundamentals';

/**
 * The ML feature snapshot job (ML brief v1 §5, ADR 0086). For each registered
 * model series and each monthly prediction date, it works out every member's
 * features as of that date's close through the back test's own market view:
 * the same bars, point-in-time filings and events store a strategy condition
 * reads, so a feature equals what a condition would have read that day. It
 * then applies the per-date cross-sectional transform and stores one row per
 * member. Once a member's 21-trading-day window has passed it records the
 * realised forward return (O152), from the same adjusted closes.
 *
 * Re-running is safe: a date with snapshots is skipped, a date with
 * predictions is frozen by the database, and a recorded label is kept.
 */

export interface SnapshotJobOptions {
  db: Database;
  /** Daily bars, through the feeds of the user whose data the job uses (the sharing admin). */
  history: HistoricalDataProvider;
  /** Point-in-time company filings, through that user's company data feed. */
  fundamentals: FundamentalsLoader;
  /** The model universe's members today (survivorship caveat, brief §13). */
  members: (universe: string) => Promise<string[]>;
  /** The user whose feeds serve the job. */
  userId: string;
  now: () => Date;
  logger: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
  /** Members loaded at once (memory). */
  batchSize?: number;
  /** Prediction dates per chunk; each chunk loads its own bars, so a pass can stop and resume. */
  chunkDates?: number;
  /** Stop after this many chunks in one pass (the evening job does a little each night). */
  maxChunks?: number;
  /** Keep a lease or heartbeat while a long chunk loads. */
  onProgress?: () => Promise<void>;
  /** Only these models (tests); every registered model otherwise. */
  modelKeys?: readonly string[];
  /** The feature set; v1 unless a test narrows it. */
  features?: readonly FeatureSpec[];
}

export interface SnapshotPassResult {
  snapshots: string[];
  labels: number;
  pendingSnapshots: number;
  pendingLabels: number;
}

/** The daily series a feature set reads for one member, plus the 252-day high and the labels. */
export function featureSeries(
  instrumentId: string,
  features: readonly FeatureSpec[] = FEATURE_SET_V1,
): DailySeries[] {
  const out: DailySeries[] = [dailyClose(instrumentId, HIGH_WINDOW)];
  for (const f of features) if (f.metric) out.push(...metricRequirements(f.metric, instrumentId));
  return out;
}

const closeOf = (date: string) => Date.parse(regularSession(date)?.close ?? `${date}T21:00:00Z`);

/** One pass over every registered model: snapshots and labels still to do, chunk by chunk. */
export async function runSnapshotPass(options: SnapshotJobOptions): Promise<SnapshotPassResult> {
  const total: SnapshotPassResult = {
    snapshots: [],
    labels: 0,
    pendingSnapshots: 0,
    pendingLabels: 0,
  };
  const models = (await listMlModelRows(options.db)).filter(
    (m) => !options.modelKeys || options.modelKeys.includes(m.modelKey),
  );
  for (const model of models) {
    const r = await snapshotModel(options, model);
    total.snapshots.push(...r.snapshots);
    total.labels += r.labels;
    total.pendingSnapshots += r.pendingSnapshots;
    total.pendingLabels += r.pendingLabels;
  }
  return total;
}

async function snapshotModel(
  options: SnapshotJobOptions,
  model: MlModelRow,
): Promise<SnapshotPassResult> {
  const { db, logger } = options;
  const features = options.features ?? FEATURE_SET_V1;
  // Dates before today only, so the evening's filings and events scans are in first.
  const nowMs = options.now().getTime();
  const todaySession = regularSession(nyDate(new Date(nowMs)));
  const lastDay = lastClosedDay(
    todaySession ? Math.min(nowMs, Date.parse(todaySession.open)) : nowMs,
  );
  const dates = predictionDates(model.snapshotsFrom, lastDay);
  const state = await snapshotState(db, model.id);
  const toSnapshot = dates.filter((d) => !state.dates.has(d) && !state.frozen.has(d));
  // A label is due once its 21st trading day has closed; dates with fewer labels than members are retried.
  const toLabel = dates.filter(
    (d) =>
      (state.dates.has(d) || toSnapshot.includes(d)) &&
      tradingDayAfter(d, LABEL_HORIZON_DAYS) <= lastDay &&
      (state.labelled.get(d) ?? 0) < (state.dates.get(d) ?? Number.POSITIVE_INFINITY),
  );
  const work = [...new Set([...toSnapshot, ...toLabel])].sort();
  const result: SnapshotPassResult = {
    snapshots: [],
    labels: 0,
    pendingSnapshots: toSnapshot.length,
    pendingLabels: toLabel.length,
  };
  if (work.length === 0) return result;
  const members = [...new Set(await options.members(model.universe))].sort();
  const refs = await db.transaction((tx) => instrumentRefs(tx, members));
  const chunkSize = options.chunkDates ?? 24;
  let chunks = 0;
  for (let i = 0; i < work.length; i += chunkSize) {
    if (options.maxChunks !== undefined && chunks >= options.maxChunks) break;
    chunks++;
    const chunk = work.slice(i, i + chunkSize);
    const snapDates = chunk.filter((d) => toSnapshot.includes(d));
    const labelDates = chunk.filter((d) => toLabel.includes(d));
    const done = await snapshotChunk(options, model, members, refs, snapDates, labelDates, lastDay);
    result.snapshots.push(...done.snapshots);
    result.labels += done.labels;
    result.pendingSnapshots -= done.snapshots.length;
    result.pendingLabels -= labelDates.length;
    logger.info(
      {
        model: model.modelKey,
        from: chunk[0],
        to: chunk.at(-1),
        snapshots: done.snapshots.length,
        labels: done.labels,
      },
      'ml snapshots written',
    );
  }
  // The availability report (brief §5): per feature, the earliest date ≥ 90% of members had it.
  if (result.snapshots.length > 0)
    await saveAvailability(
      db,
      model.id,
      featureAvailability(
        await snapshotRaw(db, model.id),
        features.map((f) => f.name),
      ),
    );
  return result;
}

async function snapshotChunk(
  options: SnapshotJobOptions,
  model: MlModelRow,
  members: readonly string[],
  refs: ReadonlyMap<string, InstrumentRef>,
  snapDates: readonly string[],
  labelDates: readonly string[],
  lastDay: string,
): Promise<{ snapshots: string[]; labels: number }> {
  const features = options.features ?? FEATURE_SET_V1;
  const names = features.map((f) => f.name);
  const all = [...snapDates, ...labelDates].sort();
  const last = all.at(-1) as string;
  // Bars up to the last label's end (never past the last closed day); the view hides later bars.
  const to =
    [...labelDates]
      .map((d) => tradingDayAfter(d))
      .sort()
      .at(-1) ?? last;
  const loadTo = to > lastDay ? lastDay : to;
  const raw = new Map<string, Map<string, FeatureValues>>(snapDates.map((d) => [d, new Map()]));
  const labels: LabelRow[] = [];
  const batch = options.batchSize ?? 25;
  const usesFilings = features.some((f) => f.source === 'EDGAR replay');
  const usesEvents = features.some((f) => f.source === 'events store');
  for (let k = 0; k < members.length; k += batch) {
    const ids = members.slice(k, k + batch).filter((id) => refs.has(id));
    if (ids.length === 0) continue;
    const exprs = ids.flatMap((id) => featureSeries(id, features));
    const data = await loadData(
      options.history,
      // Always from the model's first date: Wilder-smoothed RSI depends on where its
      // history starts, so a fixed start keeps every value independent of chunking.
      planExprs(exprs, model.snapshotsFrom, loadTo),
      refs,
      options.onProgress,
      new Set(ids),
    );
    if (usesFilings) {
      const filings = await options.fundamentals(
        options.userId,
        ids.map((id) => ({ id, symbol: refs.get(id)?.symbol ?? '' })),
        {
          perSymbolWarnings: false,
          ...(options.onProgress ? { onProgress: options.onProgress } : {}),
        },
      );
      data.fundamentals = filings.byId;
    }
    if (usesEvents)
      data.events = await loadEventData(
        options.db,
        new Map(ids.map((id) => [id, new Set(['earnings.sue_ts'])])),
      );
    const view = new MarketView(data.series, new Set(), data.fundamentals, new Map(), data.events);
    for (const date of snapDates) {
      view.advance(closeOf(date));
      const byId = raw.get(date) as Map<string, FeatureValues>;
      for (const id of ids) byId.set(id, computeFeatures(id, view, features));
    }
    // Realised forward returns (O152): adjusted close 21 trading days on ÷ close on the date − 1.
    for (const date of labelDates) {
      const end = tradingDayAfter(date);
      for (const id of ids) {
        const bars = data.series.get(`${id}|1d|split_and_dividend|regular`);
        const at = bars?.find((b) => nyDate(new Date(Date.parse(b.end) - 1)) === date);
        const after = bars?.find((b) => nyDate(new Date(Date.parse(b.end) - 1)) === end);
        if (!at || !after || at.close.lte(0)) continue;
        const forwardReturn = after.close.div(at.close).minus(1).toNumber();
        if (Number.isFinite(forwardReturn))
          labels.push({ instrumentId: id, asOf: date, labelEnd: end, forwardReturn });
      }
    }
    await options.onProgress?.();
  }
  const written: string[] = [];
  for (const date of snapDates) {
    const byId = raw.get(date) as Map<string, FeatureValues>;
    const ids = [...byId.keys()].sort();
    const rows = ids.map((id) => byId.get(id) as FeatureValues);
    const z = transformCrossSection(rows, names);
    const snapshot: SnapshotRow[] = ids.map((id, i) => ({
      instrumentId: id,
      raw: rows[i] as FeatureValues,
      features: z[i] as FeatureValues,
    }));
    await saveSnapshots(options.db, model.id, date, snapshot);
    written.push(date);
  }
  await saveLabels(options.db, model.id, labels);
  return { snapshots: written, labels: labels.length };
}
