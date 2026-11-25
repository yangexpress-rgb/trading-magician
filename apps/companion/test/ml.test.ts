import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeBars } from '@tm/db';
import { regularSession, tradingDays, type Bar, type BarRequest } from '@tm/domain';
import Decimal from 'decimal.js';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MlRun } from '../src/api';
import { runCompanion, type TrainerRunner } from '../src/companion';
import { newConfig, type CompanionConfig } from '../src/config';
import type { MinerRunner } from '../src/mining';
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

/** Daily bars the stand-in cloud serves: a steady climb, the same for every request. */
const barsFor = (r: BarRequest) => {
  const bars: Bar[] = [];
  let price = 50 + IIDS.findIndex((id) => id === r.instrumentId) * 10;
  for (const d of tradingDays('2014-01-02', r.to)) {
    price *= 1.0005;
    const session = regularSession(d);
    if (d < r.from || !session) continue;
    const v = new Decimal(price).toDecimalPlaces(4);
    bars.push({
      start: session.open,
      end: session.close,
      open: v,
      high: v,
      low: v,
      close: v,
      volume: v,
    });
  }
  return { bars, dataVersion: 'stand-in@1', warnings: [] };
};
const fetchAnswers = new Map<string, unknown>();
/** The factor store's first day here: a few weeks back, so a pass stays small. */
const FACTORS_FROM = tradingDays('2026-01-02', new Date().toISOString().slice(0, 10)).at(-15)!;
const fetchKinds: string[] = [];
/** Scans waiting in the stand-in cloud's queue. */
const queuedScans: {
  id: string;
  userId: string;
  config: unknown;
  summary: string;
  createdAt: string;
}[] = [];

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
  if (path === '/fetches' && init?.method === 'POST') {
    const body = JSON.parse(String(init.body)) as {
      kind: string;
      request: Record<string, unknown>;
    };
    fetchKinds.push(body.kind);
    const id = randomUUID();
    const answer =
      body.kind === 'members'
        ? {
            ids: IIDS,
            refs: IIDS.map((iid, i) => [
              iid,
              { symbol: `CM${i}`, assetClass: 'stock', lotSize: '1' },
            ]),
          }
        : body.kind === 'bars'
          ? encodeBars((body.request.requests as BarRequest[]).map(barsFor))
          : body.kind === 'filings'
            ? { byId: [] }
            : body.kind === 'pattern_members'
              ? {
                  members: IIDS,
                  sessionMembers: [],
                  refs: IIDS.map((iid, i) => [
                    iid,
                    { symbol: `CM${i}`, assetClass: 'stock', lotSize: '1' },
                  ]),
                  from: FACTORS_FROM,
                }
              : body.kind === 'option_signals'
                ? { byId: [] }
                : body.kind === 'pattern_scan'
                  ? { scan: queuedScans.shift() ?? null }
                  : { earnings: [], calendar: [] };
    fetchAnswers.set(id, answer);
    return Response.json({ fetchId: id }, { status: 202 });
  }
  const fetched = /^\/fetches\/([^/]+)$/.exec(path);
  if (fetched) {
    const answer = fetchAnswers.get(fetched[1]!);
    fetchAnswers.delete(fetched[1]!);
    return answer === undefined
      ? Response.json({ error: { code: 'not_found', message: 'gone' } }, { status: 404 })
      : Response.json({ status: 'done', answer });
  }
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

const round = (trainer: TrainerRunner, miner?: MinerRunner) => {
  const controller = new AbortController();
  return runCompanion({
    home,
    config,
    signal: controller.signal,
    log: () => undefined,
    fetch: cloud,
    trainer,
    ...(miner ? { miner } : {}),
    cloud: { pollMs: 1 },
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
      // Sent in instrument-id order.
      predictions: IIDS.map((id, i) => [id, i / 2]).sort((a, b) =>
        String(a[0]).localeCompare(String(b[0])),
      ),
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

  it('writes feature snapshots and labels locally from data asked of the cloud (ADR 0118)', async () => {
    await withStore(async (sql) => {
      const snaps = await sql<{ as_of: string; n: number }[]>`
        select as_of::text, count(*)::int as n from ml_feature_snapshot group by as_of order by as_of`;
      // One chunk of month ends from the model's first date, two members each.
      expect(snaps[0]).toEqual({ as_of: '2015-01-30', n: 2 });
      expect(snaps.length).toBeGreaterThan(1);
      expect(snaps.every((r) => r.n === 2)).toBe(true);
      // The date the cloud served is frozen here and never written.
      expect(snaps.some((r) => r.as_of === '2020-12-31')).toBe(false);
      const [labels] = await sql<{ n: number }[]>`select count(*)::int as n from ml_label`;
      expect(labels!.n).toBeGreaterThan(0);
      const [m] = await sql<{ availability: Record<string, string | null> | null }[]>`
        select availability from ml_model`;
      expect(m!.availability).toMatchObject({ rev_1m: '2015-01-30' });
      const job = await sql<{ error: string | null }[]>`
        select error from companion.sync_state where job = 'features'`;
      expect(job).toEqual([{ error: null }]);
    });
    expect(fetchKinds[0]).toBe('members');
    expect(fetchKinds).toContain('bars');
  });

  it('keeps its own availability report when the cloud mirror comes down again', async () => {
    await round(trainerWriting(null));
    await withStore(async (sql) => {
      const [m] = await sql<{ availability: Record<string, string | null> | null }[]>`
        select availability from ml_model`;
      expect(m!.availability).not.toBeNull();
    });
  });

  it('writes the pattern factor store locally from data asked of the cloud (ADR 0119)', async () => {
    await withStore(async (sql) => {
      const rows = await sql<{ n: number; members: number; first: string }[]>`
        select count(*)::int as n, count(distinct instrument_id)::int as members,
               min(as_of)::text as first from factor_snapshot`;
      expect(rows[0]!.members).toBe(2);
      expect(rows[0]!.first).toBe(FACTORS_FROM);
      const job = await sql<{ error: string | null }[]>`
        select error from companion.sync_state where job = 'factors'`;
      expect(job).toEqual([{ error: null }]);
    });
    expect(fetchKinds).toContain('pattern_members');
  });

  it('mines a queued scan from the cloud on the local store and sends its result once (ADR 0120)', async () => {
    const scanId = randomUUID();
    const userId = randomUUID();
    queuedScans.push({
      id: scanId,
      userId,
      config: { direction: 'spike' },
      summary: 'Spikes',
      createdAt: new Date().toISOString(),
    });
    /** What the Python miner does with a queued scan. */
    const miner: MinerRunner = async (storeUrl) => {
      const { default: postgresJs } = await import('postgres');
      const sql = postgresJs(storeUrl, { max: 1, onnotice: () => undefined });
      try {
        const [scan] = await sql<{ id: string; user_id: string }[]>`
          update pattern_scan set status = 'running', started_at = now()
          where status = 'queued' returning id::text, user_id::text`;
        if (!scan) return { code: 0, tail: [] };
        const [p] = await sql<{ id: string }[]>`
          insert into pattern (scan_id, user_id, rank, rule, stats, status)
          values (${scan.id}, ${scan.user_id}, 1, '[{"factor":"rsi_14"}]', '{"holdout":{"n":20}}', 'verified')
          returning id::text`;
        for (const [i, w] of ['discovery', 'holdout', 'fresh'].entries())
          await sql`insert into pattern_occurrence (pattern_id, user_id, instrument_id, as_of, "window", hit,
                      max_runup, max_drawdown, forward_return)
                    values (${p!.id}, ${scan.user_id}, ${IIDS[0]!}, ${`2021-0${i + 1}-04`}, ${w}, true, 0.1, -0.02, 0.05)`;
        await sql`update pattern_scan set status = 'done', candidates_tested = 50, finalists = 1, verified = 1,
                    effective = '{"from":"2020-01-02"}', code_version = 'companion', seconds = 1.5,
                    finished_at = now() where id = ${scan.id}`;
      } finally {
        await sql.end();
      }
      return { code: 0, tail: [] };
    };
    await round(trainerWriting(null), miner);
    const sent = pushes.filter((p) => p.kind === 'pattern_scan_result');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.clientKey).toBe(`scan:${scanId}`);
    expect(sent[0]!.payload).toMatchObject({
      scan: { id: scanId, status: 'done', verified: 1, seconds: 1.5 },
      patterns: [{ rank: 1, status: 'verified' }],
    });
    // The scan's own evidence only; the live occurrence stays here.
    const [pattern] = (sent[0]!.payload as { patterns: { occurrences: unknown[][] }[] }).patterns;
    expect(pattern!.occurrences.map((o) => o[2])).toEqual(['discovery', 'holdout']);
    await round(trainerWriting(null), miner);
    expect(pushes.filter((p) => p.kind === 'pattern_scan_result')).toHaveLength(1);
  });
});
