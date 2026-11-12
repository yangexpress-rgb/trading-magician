import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  listMlModels,
  loadMlPredictions,
  mlModelByKey,
  saveLabels,
  saveSnapshots,
  snapshotState,
} from '../src/ml';
import { instruments, mlModelRuns, mlPredictions } from '../src/schema';
import { createTestDatabase, type TestDatabase } from './harness';

/**
 * ML prediction storage (ML brief v1 §4, ADR 0086): the seeded model series,
 * the embargo recorded on every run, immutable predictions, superseded runs
 * never read, and snapshots frozen once a date has predictions.
 */

let t: TestDatabase;
let modelId: string;
let a: string;
let b: string;

beforeAll(async () => {
  t = await createTestDatabase();
  const rows = await t.owner.db.select().from(instruments);
  a = rows.find((r) => r.symbol === 'DEMO-A')!.id;
  b = rows.find((r) => r.symbol === 'DEMO-B')!.id;
  modelId = (await mlModelByKey(t.worker.db, 'mf-ranker-ridge'))!.id;
});

afterAll(async () => {
  await t?.drop();
});

/** The database's own message, under drizzle's "Failed query" wrapper. */
async function dbError(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    const err = e as { message: string; cause?: { message?: string } };
    return err.cause?.message ?? err.message;
  }
  throw new Error('expected the database to refuse');
}

let runNo = 0;
async function insertRun(predictionDate: string, maxLabelEnd: string) {
  const [row] = await t.worker.db
    .insert(mlModelRuns)
    .values({
      modelId,
      runNo: ++runNo,
      predictionDate,
      trainingStart: '2018-01-31',
      trainingEnd: '2020-01-31',
      maxLabelEnd,
      rowsTrained: 100,
      crossSections: 18,
      hyperparams: { alpha: 10 },
      coefficients: { mom_12_1: 0.1 },
      codeVersion: 'test',
    })
    .returning({ id: mlModelRuns.id });
  return row!.id;
}

describe('ML prediction storage', () => {
  it('seeds the S&P 500 multi-factor ranker as a registered series', async () => {
    const m = await mlModelByKey(t.worker.db, 'mf-ranker-ridge');
    expect(m).toMatchObject({ universe: 'sp500', algorithm: 'ridge', status: 'registered' });
    expect(m?.featureSet).toHaveLength(11);
    expect(await listMlModels(t.app.db)).toEqual([
      expect.objectContaining({ modelKey: 'mf-ranker-ridge', latestTrainingEnd: null }),
    ]);
  });

  it('refuses a run whose labels end on or after the date it predicts (embargo, §7)', async () => {
    await expect(insertRun('2020-03-31', '2020-03-31')).rejects.toThrow();
  });

  it('stores predictions immutably: no update or delete, even for the owner', async () => {
    const run = await insertRun('2020-03-31', '2020-03-02');
    await t.worker.db.insert(mlPredictions).values([
      { modelRunId: run, instrumentId: a, asOf: '2020-03-31', score: 0.5 },
      { modelRunId: run, instrumentId: b, asOf: '2020-03-31', score: -0.5 },
    ]);
    expect(
      await dbError(
        t.owner.db.update(mlPredictions).set({ score: 9 }).where(eq(mlPredictions.modelRunId, run)),
      ),
    ).toMatch(/immutable/);
    expect(
      await dbError(t.owner.db.delete(mlPredictions).where(eq(mlPredictions.modelRunId, run))),
    ).toMatch(/immutable/);
    // The app login reads them, but cannot write.
    const read = await loadMlPredictions(t.app.db, new Map([['mf-ranker-ridge', new Set([a, b])]]));
    expect(read.get('mf-ranker-ridge')?.get(a)).toEqual([
      { asOf: '2020-03-31', score: 0.5, runNo: expect.any(Number), trainingEnd: '2020-01-31' },
    ]);
    expect(
      await dbError(
        t.app.db
          .insert(mlPredictions)
          .values({ modelRunId: run, instrumentId: a, asOf: '2020-04-30', score: 1 }),
      ),
    ).toMatch(/permission denied/);
  });

  it('supersedes a bad run instead of editing it, and never reads it again', async () => {
    const bad = await insertRun('2020-04-30', '2020-03-31');
    await t.worker.db
      .insert(mlPredictions)
      .values({ modelRunId: bad, instrumentId: a, asOf: '2020-04-30', score: 99 });
    // Only active → superseded is allowed; nothing else on the run changes.
    expect(
      await dbError(
        t.worker.db.update(mlModelRuns).set({ rowsTrained: 1 }).where(eq(mlModelRuns.id, bad)),
      ),
    ).toMatch(/active to superseded/);
    await t.worker.db
      .update(mlModelRuns)
      .set({ status: 'superseded' })
      .where(eq(mlModelRuns.id, bad));
    const fixed = await insertRun('2020-04-30', '2020-03-31');
    await t.worker.db
      .insert(mlPredictions)
      .values({ modelRunId: fixed, instrumentId: a, asOf: '2020-04-30', score: 0.25 });
    const read = await loadMlPredictions(t.app.db, new Map([['mf-ranker-ridge', new Set([a])]]));
    expect(
      read
        .get('mf-ranker-ridge')
        ?.get(a)
        ?.map((p) => [p.asOf, p.score]),
    ).toEqual([
      ['2020-03-31', 0.5],
      ['2020-04-30', 0.25],
    ]);
    // Two active runs for one date are refused.
    await expect(insertRun('2020-04-30', '2020-03-31')).rejects.toThrow();
  });

  it('freezes a date’s snapshots once predictions exist for it (§5)', async () => {
    const features = { mom_12_1: 1 };
    await saveSnapshots(t.worker.db, modelId, '2020-05-29', [
      { instrumentId: a, features, raw: features },
    ]);
    // Re-running a date without predictions replaces its rows.
    await saveSnapshots(t.worker.db, modelId, '2020-05-29', [
      { instrumentId: a, features, raw: features },
      { instrumentId: b, features, raw: features },
    ]);
    await saveSnapshots(t.worker.db, modelId, '2020-03-31', [
      { instrumentId: a, features, raw: features },
    ]).catch(() => undefined);
    expect(
      await dbError(
        saveSnapshots(t.worker.db, modelId, '2020-03-31', [
          { instrumentId: b, features, raw: features },
        ]),
      ),
    ).toMatch(/frozen/);
    const state = await snapshotState(t.worker.db, modelId);
    expect(state.dates.get('2020-05-29')).toBe(2);
    expect(state.frozen.has('2020-03-31')).toBe(true);
  });

  it('records a realised label once and keeps it', async () => {
    await saveLabels(t.worker.db, modelId, [
      { instrumentId: a, asOf: '2020-05-29', labelEnd: '2020-06-30', forwardReturn: 0.02 },
    ]);
    await saveLabels(t.worker.db, modelId, [
      { instrumentId: a, asOf: '2020-05-29', labelEnd: '2020-06-30', forwardReturn: 0.5 },
    ]);
    const [row] = await t.owner.db.execute<{ forward_return: number }>(
      sql`select forward_return from ml_label where instrument_id = ${a} and as_of = '2020-05-29'`,
    );
    expect(Number(row?.forward_return)).toBe(0.02);
  });
});
