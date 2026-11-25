import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Transaction } from '../src/client';
import { companionHello, pairCompanion, unpairCompanion } from '../src/companion';
import {
  applyCompanionPushes,
  companionMlState,
  companionRunPredictions,
  listCompanionPushes,
  queueCompanionPush,
  type MlRunPush,
} from '../src/companion-push';
import { listMlModels } from '../src/ml';
import { instruments, mlModelRuns, users } from '../src/schema';
import { withTenant } from '../src/tenant';
import { createTestDatabase, type TestDatabase } from './harness';

/**
 * The Local Companion's inbox (ADR 0117, S2 step 3a): the web app queues a
 * push as the person, the worker applies it to Core and the Research Store,
 * only for the producer's live pairing, once, and the builder's model list
 * then says where the latest run was made (A5).
 */

let t: TestDatabase;
let admin: string;
let member: string;
let adminConn: string;
let memberConn: string;
let iids: string[];

const asUser = <T>(userId: string, fn: (tx: Transaction) => Promise<T>) =>
  withTenant(t.app.db, { userId }, fn);
const apply = () => applyCompanionPushes({ core: t.worker.db, research: t.research!.worker.db });

async function createUser(email: string): Promise<string> {
  const [row] = await t.auth.db
    .insert(users)
    .values({ name: email.split('@')[0] ?? email, email })
    .returning({ id: users.id });
  return row!.id;
}

function runPush(predictionDate: string, overrides: Partial<MlRunPush['run']> = {}): MlRunPush {
  return {
    run: {
      id: randomUUID(),
      modelKey: 'mf-ranker-ridge',
      predictionDate,
      trainingStart: '2015-01-30',
      trainingEnd: '2020-11-30',
      maxLabelEnd: '2020-12-30',
      rowsTrained: 9000,
      crossSections: 60,
      hyperparams: { alpha: 10 },
      coefficients: { mom_12_1: 0.12, '(intercept)': 0 },
      codeVersion: 'ml-trainer 0.1.0 (companion)',
      ...overrides,
    },
    predictions: iids.map((id, i) => [id, i / 10] as [string, number]),
  };
}

beforeAll(async () => {
  t = await createTestDatabase({ research: true });
  admin = await createUser('inbox-admin@example.com');
  member = await createUser('inbox-member@example.com');
  await t.owner.db.execute(sql`insert into platform_admin (user_id) values (${admin})`);
  const rows = await t.owner.db.select({ id: instruments.id }).from(instruments).limit(3);
  iids = rows.map((r) => r.id);
  expect(iids.length).toBeGreaterThan(1);
  adminConn = (await asUser(admin, (tx) => pairCompanion(tx, admin))).connection.id;
  memberConn = (await asUser(member, (tx) => pairCompanion(tx, member))).connection.id;
  await asUser(admin, (tx) =>
    companionHello(
      tx,
      { connectionId: adminConn, userId: admin },
      { version: '0.2.0', platform: 'darwin-arm64' },
    ),
  );
});

afterAll(async () => {
  await t?.drop();
});

describe('Local Companion inbox (ADR 0117)', () => {
  const runFor2021 = () => runPush('2021-01-29');
  let firstRun: MlRunPush;

  it('applies a pushed run with its predictions, keeping the companion’s run id', async () => {
    firstRun = runFor2021();
    const who = { connectionId: adminConn, userId: admin };
    const queued = await asUser(admin, (tx) =>
      queueCompanionPush(tx, who, {
        kind: 'ml_run',
        clientKey: `run:${firstRun.run.id}`,
        payload: firstRun,
      }),
    );
    const again = await asUser(admin, (tx) =>
      queueCompanionPush(tx, who, {
        kind: 'ml_run',
        clientKey: `run:${firstRun.run.id}`,
        payload: firstRun,
      }),
    );
    expect(again).toEqual({ id: queued.id, duplicate: true });

    const applied = await apply();
    expect(applied).toEqual([
      { id: queued.id, kind: 'ml_run', result: { runNo: 1, predictions: iids.length } },
    ]);
    const [run] = await t.worker.db
      .select()
      .from(mlModelRuns)
      .where(eq(mlModelRuns.id, firstRun.run.id));
    expect(run).toMatchObject({
      predictionDate: '2021-01-29',
      source: 'companion',
      sourceDetail: 'Local companion 0.2.0 (darwin-arm64)',
    });
    expect(await asUser(admin, (tx) => companionRunPredictions(tx, firstRun.run.id))).toHaveLength(
      iids.length,
    );
    const frozen = await t.research!.worker.db.execute(
      sql`select 1 from ml_frozen_as_of where as_of = '2021-01-29'`,
    );
    expect(frozen.length).toBe(1);
    expect(await apply()).toEqual([]);
  });

  it('shows the companion as the source of the latest scores (A5)', async () => {
    const [model] = await listMlModels(t.app.db);
    expect(model).toMatchObject({
      latestPrediction: '2021-01-29',
      latestSource: 'Local companion 0.2.0 (darwin-arm64)',
    });
    expect(model!.latestMadeAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('serves the registry and active runs for the local mirror', async () => {
    const state = await asUser(admin, (tx) => companionMlState(tx));
    expect(state.models.map((m) => m.modelKey)).toContain('mf-ranker-ridge');
    expect(state.runs).toEqual([
      expect.objectContaining({ id: firstRun.run.id, runNo: 1, source: 'companion' }),
    ]);
  });

  it('never rewrites a served date, and applies evaluations and reports to the Research Store', async () => {
    const who = { connectionId: adminConn, userId: admin };
    const dup = runPush('2021-01-29');
    await asUser(admin, (tx) =>
      queueCompanionPush(tx, who, { kind: 'ml_run', clientKey: `run:${dup.run.id}`, payload: dup }),
    );
    await asUser(admin, (tx) =>
      queueCompanionPush(tx, who, {
        kind: 'ml_evaluation',
        clientKey: `eval:${firstRun.run.id}`,
        payload: {
          modelRunId: firstRun.run.id,
          asOf: '2021-01-29',
          ic: 0.04,
          universeSize: 500,
          predicted: iids.length,
          labelled: iids.length,
          decileSpread: 0.01,
        },
      }),
    );
    const reportId = randomUUID();
    await asUser(admin, (tx) =>
      queueCompanionPush(tx, who, {
        kind: 'ml_report',
        clientKey: `report:${reportId}`,
        payload: {
          id: reportId,
          modelKey: 'mf-ranker-ridge',
          markdown: '# Report',
          summary: { runs: 1 },
          codeVersion: 'ml-trainer 0.1.0 (companion)',
        },
      }),
    );
    const applied = await apply();
    expect(applied.map((a) => a.result)).toEqual([
      { skipped: 'date already served', servedBy: firstRun.run.id, runNo: 1 },
      { evaluated: '2021-01-29' },
      { report: reportId },
    ]);
    const evals = await t.research!.worker.db.execute(sql`select ic from ml_evaluation`);
    expect(evals).toHaveLength(1);
  });

  it('refuses a run that breaks the embargo, and records why', async () => {
    const who = { connectionId: adminConn, userId: admin };
    const bad = runPush('2021-02-26', { maxLabelEnd: '2021-03-31' });
    await asUser(admin, (tx) =>
      queueCompanionPush(tx, who, { kind: 'ml_run', clientKey: `run:${bad.run.id}`, payload: bad }),
    );
    const [applied] = await apply();
    expect(applied?.error).toMatch(/Refused by the database/);
    const [listed] = await asUser(admin, (tx) =>
      listCompanionPushes(tx, adminConn, { pendingOrFailed: true }),
    );
    expect(listed).toMatchObject({ clientKey: `run:${bad.run.id}`, appliedAt: null });
    expect(listed!.error).toMatch(/Refused/);
  });

  it('refuses pushes from anyone but the producer, and from an unpaired companion', async () => {
    const fromMember = runPush('2021-03-31');
    await asUser(member, (tx) =>
      queueCompanionPush(
        tx,
        { connectionId: memberConn, userId: member },
        {
          kind: 'ml_run',
          clientKey: `run:${fromMember.run.id}`,
          payload: fromMember,
        },
      ),
    );
    const late = runPush('2021-04-30');
    await asUser(admin, (tx) =>
      queueCompanionPush(
        tx,
        { connectionId: adminConn, userId: admin },
        {
          kind: 'ml_run',
          clientKey: `run:${late.run.id}`,
          payload: late,
        },
      ),
    );
    await asUser(admin, (tx) => unpairCompanion(tx, admin, adminConn));
    const applied = await apply();
    expect(applied.map((a) => a.error)).toEqual([
      'Only the research producer’s companion may publish shared research',
      'The companion was unpaired before this push was applied',
    ]);
    const runs = await t.worker.db.select({ id: mlModelRuns.id }).from(mlModelRuns);
    expect(runs).toHaveLength(1);
  });

  it('keeps each person’s pushes to themselves', async () => {
    expect(await asUser(member, (tx) => listCompanionPushes(tx, adminConn))).toEqual([]);
  });
});
