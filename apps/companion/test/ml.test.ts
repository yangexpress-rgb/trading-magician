import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MlRun } from '../src/api';
import { runCompanion, type TrainerRunner } from '../src/companion';
import { newConfig, type CompanionConfig } from '../src/config';
import { startLocalStore } from '../src/store';

/**
 * ML on the companion (ADR 0117, S2 step 3a), against a real local Postgres
 * and a stand-in cloud: the cloud's runs come down into the local mirror and
 * are never sent back; what the trainer makes goes up once; and when the
 * cloud serves a date first, its run replaces the local one. The trainer
 * itself is a stand-in that writes what the Python trainer writes.
 */

const isRoot = process.getuid?.() === 0;
const port = 60_000 + Math.floor(Math.random() * 4_000);

const MODEL_ID = randomUUID();
const model = {
  id: MODEL_ID,
  modelKey: 'mf-ranker-ridge',
  name: 'Multi-factor ranker',
  universe: 'sp500',
  featureSet: ['mom_12_1'],
  featureSetVersion: 1,
  label: { horizon: 21 },
  algorithm: 'ridge',
  status: 'registered',
  snapshotsFrom: '2015-01-30',
  availability: null,
};
const IIDS = [randomUUID(), randomUUID()];

const run = (predictionDate: string, source = 'cloud', id: string = randomUUID()): MlRun => ({
  id,
  modelId: MODEL_ID,
  runNo: 0,
  predictionDate,
  trainingStart: '2015-01-30',
  trainingEnd: '2020-10-30',
  maxLabelEnd: '2020-11-30',
  rowsTrained: 100,
  crossSections: 20,
  hyperparams: { alpha: 10 },
  coefficients: { mom_12_1: 0.1 },
  codeVersion: 'ml-trainer 0.1.0',
  source,
  createdAt: new Date().toISOString(),
});

let dir: string;
let home: string;
let config: CompanionConfig;
const cloudRuns: MlRun[] = [];
const pushes: { kind: string; clientKey: string; payload: Record<string, unknown> }[] = [];
/** When set, the cloud "already serves" this date with its own run instead of applying the push. */
let serveFirst: { date: string; id: string } | null = null;

const cloud = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace('/api/companion/v1', '');
  if (path === '/hello') {
    return Response.json({ connectionId: 'c1', seenAt: new Date().toISOString(), serverTime: 'x' });
  }
  if (path === '/instruments') return Response.json({ instruments: [], next: null });
  if (path === '/membership') return Response.json({ periods: [] });
  if (path === '/ml/state') {
    cloudRuns.forEach((r, i) => (r.runNo = i + 1));
    return Response.json({ models: [model], runs: cloudRuns });
  }
  const predictions = /^\/ml\/runs\/([^/]+)\/predictions$/.exec(path);
  if (predictions) return Response.json({ predictions: IIDS.map((id, i) => [id, i]) });
  if (path === '/pushes' && init?.method === 'POST') {
    const body = JSON.parse(String(init.body)) as (typeof pushes)[number];
    pushes.push(body);
    if (body.kind === 'ml_run') {
      const r = (body.payload as { run: MlRun }).run;
      if (serveFirst && r.predictionDate === serveFirst.date) {
        cloudRuns.push(run(serveFirst.date, 'cloud', serveFirst.id));
      } else {
        cloudRuns.push({ ...run(r.predictionDate, 'companion', r.id) });
      }
    }
    return Response.json({ pushId: randomUUID(), duplicate: false }, { status: 202 });
  }
  if (path === '/pushes') return Response.json({ pushes: [] });
  return new Response('not found', { status: 404 });
}) as typeof fetch;

/** What the Python trainer writes for one new date, plus an evaluation and a report. */
const trainerWriting =
  (date: string | null): TrainerRunner =>
  async (storeUrl) => {
    if (!date) return { code: 0, tail: [] };
    const { default: postgresJs } = await import('postgres');
    const sql = postgresJs(storeUrl, { max: 1, onnotice: () => undefined });
    try {
      await sql.begin(async (tx) => {
        const [r] = await tx<{ id: string }[]>`
          insert into ml_model_run (model_id, run_no, prediction_date, training_start, training_end,
            max_label_end, rows_trained, cross_sections, hyperparams, coefficients, code_version)
          values (${MODEL_ID}, 99, ${date}, '2015-01-30', '2020-12-31', '2021-01-04', 120, 21,
            '{"alpha": 1}', '{"mom_12_1": 0.2}', 'ml-trainer 0.1.0 @ companion')
          returning id::text`;
        for (const [i, iid] of IIDS.entries()) {
          await tx`insert into ml_prediction (model_run_id, instrument_id, as_of, score)
                   values (${r!.id}, ${iid}, ${date}, ${i / 2})`;
        }
        await tx`insert into ml_report (model_id, markdown, summary, code_version)
                 values (${MODEL_ID}, ${`# Report ${date}`}, '{"runs": 1}', 'ml-trainer 0.1.0 @ companion')`;
      });
      const [first] = await sql<{ id: string; prediction_date: string }[]>`
        select id::text, prediction_date::text from ml_model_run where source = 'cloud' order by prediction_date limit 1`;
      if (first) {
        await sql`insert into ml_evaluation (model_run_id, as_of, ic, universe_size, predicted, labelled, decile_spread)
                  values (${first.id}, ${first.prediction_date}, 0.03, 500, 2, 2, 0.01) on conflict do nothing`;
      }
    } finally {
      await sql.end();
    }
    return { code: 0, tail: [] };
  };

const round = (trainer: TrainerRunner) => {
  const controller = new AbortController();
  return runCompanion({
    home,
    config,
    signal: controller.signal,
    log: () => undefined,
    fetch: cloud,
    trainer,
    hooks: { sleep: async () => controller.abort() },
  });
};

async function withStore<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const store = await startLocalStore({ home, port, password: config.pgPassword });
  try {
    return await fn(store.sql);
  } finally {
    await store.stop();
  }
}

describe.skipIf(isRoot)('ML on the Local Companion (ADR 0117)', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tm-companion-ml-'));
    await chmod(dir, 0o700);
    home = join(dir, 'home');
    config = {
      ...newConfig({ apiBase: 'https://tm.example', token: 'tma_test' }, null),
      pgPort: port,
    };
    cloudRuns.push(run('2020-12-31'));
  });

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('mirrors the cloud’s runs and pushes only what the companion made', async () => {
    expect(await round(trainerWriting('2021-01-29'))).toEqual({ kind: 'aborted' });
    expect(pushes.map((p) => p.kind)).toEqual(['ml_run', 'ml_evaluation', 'ml_report']);
    const [runPush, evalPush] = pushes;
    expect(runPush!.payload).toMatchObject({
      run: { modelKey: 'mf-ranker-ridge', predictionDate: '2021-01-29', maxLabelEnd: '2021-01-04' },
      predictions: IIDS.map((id, i) => [id, i / 2]),
    });
    expect(evalPush!.payload).toMatchObject({ modelRunId: cloudRuns[0]!.id, asOf: '2020-12-31' });
    await withStore(async (sql) => {
      const runs = await sql<{ prediction_date: string; source: string }[]>`
        select prediction_date::text, source from ml_model_run order by prediction_date`;
      expect(runs).toEqual([
        { prediction_date: '2020-12-31', source: 'cloud' },
        { prediction_date: '2021-01-29', source: 'companion' },
      ]);
      const frozen = await sql`select 1 from ml_frozen_as_of where as_of = '2020-12-31'`;
      expect(frozen).toHaveLength(1);
      const job = await sql<
        { error: string | null }[]
      >`select error from companion.sync_state where job = 'ml'`;
      expect(job).toEqual([{ error: null }]);
    });
  });

  it('sends nothing twice', async () => {
    await round(trainerWriting(null));
    expect(pushes).toHaveLength(3);
  });

  it('gives way when the cloud serves a date first', async () => {
    const cloudId = randomUUID();
    serveFirst = { date: '2021-02-26', id: cloudId };
    await round(trainerWriting('2021-02-26'));
    expect(pushes.filter((p) => p.kind === 'ml_run')).toHaveLength(2);
    await round(trainerWriting(null));
    await withStore(async (sql) => {
      const runs = await sql<{ id: string }[]>`
        select id::text from ml_model_run where prediction_date = '2021-02-26' and status = 'active'`;
      expect(runs).toEqual([{ id: cloudId }]);
    });
    expect(pushes.filter((p) => p.kind === 'ml_run')).toHaveLength(2);
  });
});
