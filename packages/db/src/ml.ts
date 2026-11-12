import type { FeatureValues, MlPrediction } from '@tm/domain';
import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { Database, Transaction } from './client';
import {
  instruments,
  mlFeatureSnapshots,
  mlLabels,
  mlModelRuns,
  mlModels,
  mlPredictions,
} from './schema';

/**
 * Machine-learning prediction signals (ML brief v1 §4, ADR 0086). Global data
 * kept once for every tenant, like options signals. The app reads the model
 * list and the scores; the worker writes snapshots and labels; the trainer
 * service writes runs, predictions and evaluations.
 */

type Db = Database | Transaction;

const CHUNK = 1000;

export interface MlModelRow {
  id: string;
  modelKey: string;
  name: string;
  theoryNumber: string | null;
  universe: string;
  featureSet: string[];
  featureSetVersion: number;
  algorithm: string;
  status: 'registered' | 'retired';
  snapshotsFrom: string;
  availability: Record<string, string | null> | null;
}

const modelRow = (r: typeof mlModels.$inferSelect): MlModelRow => ({
  id: r.id,
  modelKey: r.modelKey,
  name: r.name,
  theoryNumber: r.theoryNumber,
  universe: r.universe,
  featureSet: r.featureSet as string[],
  featureSetVersion: r.featureSetVersion,
  algorithm: r.algorithm,
  status: r.status as MlModelRow['status'],
  snapshotsFrom: r.snapshotsFrom,
  availability: (r.availability as Record<string, string | null> | null) ?? null,
});

export async function listMlModelRows(db: Db, registeredOnly = true): Promise<MlModelRow[]> {
  const rows = await db
    .select()
    .from(mlModels)
    .where(registeredOnly ? eq(mlModels.status, 'registered') : sql`true`)
    .orderBy(asc(mlModels.modelKey));
  return rows.map(modelRow);
}

export async function mlModelByKey(db: Db, modelKey: string): Promise<MlModelRow | undefined> {
  const [row] = await db.select().from(mlModels).where(eq(mlModels.modelKey, modelKey));
  return row ? modelRow(row) : undefined;
}

/** A model series as the builder's picker shows it (brief §8). */
export interface MlModelChoice {
  modelKey: string;
  name: string;
  status: 'registered' | 'retired';
  /** The latest active run's training end, or null before the first run. */
  latestTrainingEnd: string | null;
  /** The latest prediction date with an active run, or null. */
  latestPrediction: string | null;
}

export async function listMlModels(db: Db): Promise<MlModelChoice[]> {
  const models = await listMlModelRows(db);
  if (models.length === 0) return [];
  const latest = await db
    .select({
      modelId: mlModelRuns.modelId,
      trainingEnd: sql<string | null>`max(${mlModelRuns.trainingEnd})::text`,
      prediction: sql<string | null>`max(${mlModelRuns.predictionDate})::text`,
    })
    .from(mlModelRuns)
    .where(eq(mlModelRuns.status, 'active'))
    .groupBy(mlModelRuns.modelId);
  const byModel = new Map(latest.map((r) => [r.modelId, r]));
  return models.map((m) => ({
    modelKey: m.modelKey,
    name: m.name,
    status: m.status,
    latestTrainingEnd: byModel.get(m.id)?.trainingEnd ?? null,
    latestPrediction: byModel.get(m.id)?.prediction ?? null,
  }));
}

/**
 * Stored scores for the reads a strategy makes (brief §8), mirroring
 * `loadOptionSignals`: by model key, the instruments' predictions from
 * active runs, each list sorted by date. Superseded runs are never read.
 * Should two active runs ever score the same member on the same date, the
 * later run wins.
 */
export async function loadMlPredictions(
  db: Db,
  reads: ReadonlyMap<string, ReadonlySet<string>>,
  fromDate?: string,
): Promise<Map<string, Map<string, MlPrediction[]>>> {
  const out = new Map<string, Map<string, MlPrediction[]>>();
  for (const [modelKey, ids] of reads) {
    const byInstrument = new Map<string, MlPrediction[]>();
    out.set(modelKey, byInstrument);
    const list = [...ids];
    for (let i = 0; i < list.length; i += CHUNK) {
      const rows = await db
        .select({
          instrumentId: mlPredictions.instrumentId,
          asOf: mlPredictions.asOf,
          score: mlPredictions.score,
          runNo: mlModelRuns.runNo,
          trainingEnd: mlModelRuns.trainingEnd,
        })
        .from(mlPredictions)
        .innerJoin(mlModelRuns, eq(mlModelRuns.id, mlPredictions.modelRunId))
        .innerJoin(mlModels, eq(mlModels.id, mlModelRuns.modelId))
        .where(
          and(
            eq(mlModels.modelKey, modelKey),
            eq(mlModelRuns.status, 'active'),
            inArray(mlPredictions.instrumentId, list.slice(i, i + CHUNK)),
            fromDate ? gte(mlPredictions.asOf, fromDate) : sql`true`,
          ),
        )
        .orderBy(asc(mlPredictions.asOf), asc(mlModelRuns.runNo));
      for (const r of rows) {
        const preds = byInstrument.get(r.instrumentId) ?? [];
        const p: MlPrediction = {
          asOf: r.asOf,
          score: r.score,
          runNo: r.runNo,
          trainingEnd: r.trainingEnd,
        };
        if (preds.at(-1)?.asOf === r.asOf) preds[preds.length - 1] = p;
        else preds.push(p);
        byInstrument.set(r.instrumentId, preds);
      }
    }
  }
  return out;
}

/** The first and last prediction dates a model has active runs for, or undefined. */
export async function mlPredictionRange(
  db: Db,
  modelKey: string,
): Promise<{ first: string; last: string } | undefined> {
  const [row] = await db
    .select({
      first: sql<string | null>`min(${mlModelRuns.predictionDate})::text`,
      last: sql<string | null>`max(${mlModelRuns.predictionDate})::text`,
    })
    .from(mlModelRuns)
    .innerJoin(mlModels, eq(mlModels.id, mlModelRuns.modelId))
    .where(and(eq(mlModels.modelKey, modelKey), eq(mlModelRuns.status, 'active')));
  return row?.first && row.last ? { first: row.first, last: row.last } : undefined;
}

// ---------------------------------------------------------------------------
// Snapshot job (brief §5): worker only.

/** Prediction dates with snapshots, and those frozen because predictions exist. */
export async function snapshotState(
  db: Db,
  modelId: string,
): Promise<{ dates: Map<string, number>; frozen: Set<string>; labelled: Map<string, number> }> {
  const snap = await db
    .select({ asOf: mlFeatureSnapshots.asOf, n: sql<number>`count(*)::int` })
    .from(mlFeatureSnapshots)
    .where(eq(mlFeatureSnapshots.modelId, modelId))
    .groupBy(mlFeatureSnapshots.asOf);
  const frozen = await db
    .selectDistinct({ asOf: mlPredictions.asOf })
    .from(mlPredictions)
    .innerJoin(mlModelRuns, eq(mlModelRuns.id, mlPredictions.modelRunId))
    .where(eq(mlModelRuns.modelId, modelId));
  const labels = await db
    .select({ asOf: mlLabels.asOf, n: sql<number>`count(*)::int` })
    .from(mlLabels)
    .where(eq(mlLabels.modelId, modelId))
    .groupBy(mlLabels.asOf);
  return {
    dates: new Map(snap.map((r) => [r.asOf, r.n])),
    frozen: new Set(frozen.map((r) => r.asOf)),
    labelled: new Map(labels.map((r) => [r.asOf, r.n])),
  };
}

export interface SnapshotRow {
  instrumentId: string;
  features: FeatureValues;
  raw: FeatureValues;
}

/**
 * Writes one date's snapshots (brief §5 step 4): replaces that date's rows,
 * which the database refuses once any prediction exists for the date.
 */
export async function saveSnapshots(
  db: Database,
  modelId: string,
  asOf: string,
  rows: readonly SnapshotRow[],
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(mlFeatureSnapshots)
      .where(and(eq(mlFeatureSnapshots.modelId, modelId), eq(mlFeatureSnapshots.asOf, asOf)));
    for (let i = 0; i < rows.length; i += CHUNK)
      await tx.insert(mlFeatureSnapshots).values(
        rows.slice(i, i + CHUNK).map((r) => ({
          modelId,
          instrumentId: r.instrumentId,
          asOf,
          features: r.features,
          raw: r.raw,
        })),
      );
  });
}

export interface LabelRow {
  instrumentId: string;
  asOf: string;
  labelEnd: string;
  forwardReturn: number;
}

/** Records realised forward returns once; a label already recorded is kept as it was. */
export async function saveLabels(db: Db, modelId: string, rows: readonly LabelRow[]) {
  for (let i = 0; i < rows.length; i += CHUNK)
    await db
      .insert(mlLabels)
      .values(rows.slice(i, i + CHUNK).map((r) => ({ modelId, ...r })))
      .onConflictDoNothing();
}

/** The availability report (brief §5): per feature, the earliest date ≥ 90% of members had a value. */
export async function saveAvailability(
  db: Db,
  modelId: string,
  availability: Record<string, string | null>,
) {
  await db
    .update(mlModels)
    .set({ availability, updatedAt: new Date() })
    .where(eq(mlModels.id, modelId));
}

/** Members' raw snapshot values by date, for the availability report. */
export async function snapshotRaw(db: Db, modelId: string): Promise<Map<string, FeatureValues[]>> {
  const rows = await db
    .select({ asOf: mlFeatureSnapshots.asOf, raw: mlFeatureSnapshots.raw })
    .from(mlFeatureSnapshots)
    .where(eq(mlFeatureSnapshots.modelId, modelId))
    .orderBy(asc(mlFeatureSnapshots.asOf));
  const out = new Map<string, FeatureValues[]>();
  for (const r of rows) {
    const list = out.get(r.asOf) ?? [];
    list.push(r.raw as FeatureValues);
    out.set(r.asOf, list);
  }
  return out;
}

/** Symbols of instruments, for logs and reports. */
export async function mlInstrumentSymbols(db: Db, ids: readonly string[]) {
  if (ids.length === 0) return new Map<string, string>();
  const rows = await db
    .select({ id: instruments.id, symbol: instruments.symbol })
    .from(instruments)
    .where(inArray(instruments.id, [...ids]));
  return new Map(rows.map((r) => [r.id, r.symbol]));
}

/** The latest active run of a model, for the paper runtime's staleness note. */
export async function latestMlRun(db: Db, modelKey: string) {
  const [row] = await db
    .select({
      runNo: mlModelRuns.runNo,
      predictionDate: mlModelRuns.predictionDate,
      trainingEnd: mlModelRuns.trainingEnd,
    })
    .from(mlModelRuns)
    .innerJoin(mlModels, eq(mlModels.id, mlModelRuns.modelId))
    .where(and(eq(mlModels.modelKey, modelKey), eq(mlModelRuns.status, 'active')))
    .orderBy(desc(mlModelRuns.predictionDate))
    .limit(1);
  return row;
}
