import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Transaction } from '../src/client';
import {
  COMPANION_OFFLINE_AFTER_MS,
  companionHello,
  pairCompanion,
  researchStorageStatus,
  unpairCompanion,
} from '../src/companion';
import {
  claimPatternScan,
  patternsDueForDecay,
  releaseStalledPatternScans,
} from '../src/companion-fetch';
import {
  applyCompanionPushes,
  companionMlState,
  companionRunPredictions,
  listCompanionPushes,
  queueCompanionPush,
  type MlRunPush,
} from '../src/companion-push';
import { listMlModels, loadMlPredictions } from '../src/ml';
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

  it('writes a pattern scan the companion ran into the cloud, once (ADR 0120)', async () => {
    const who = { connectionId: adminConn, userId: admin };
    const scanId = randomUUID();
    await t.research!.owner.db.execute(sql`
      insert into pattern_scan (id, user_id, config, summary) values
        (${scanId}, ${member}, '{}'::jsonb, 'Spikes after gaps')`);
    const claimed = await claimPatternScan(t.research!.worker.db);
    expect(claimed.scan).toMatchObject({
      id: scanId,
      userId: member,
      summary: 'Spikes after gaps',
    });
    expect((await claimPatternScan(t.research!.worker.db)).scan).toBeNull();
    const patternId = randomUUID();
    const payload = {
      scan: {
        id: scanId,
        status: 'done' as const,
        error: null,
        candidatesTested: 120,
        finalists: 1,
        verified: 1,
        effective: { from: '2020-01-02' },
        codeVersion: 'companion',
        seconds: 4.5,
      },
      patterns: [
        {
          id: patternId,
          rank: 1,
          rule: [{ factor: 'rsi_14', op: '<', value: 30 }],
          stats: { holdout: { n: 20 } },
          status: 'verified' as const,
          occurrences: [
            [iids[0]!, '2021-03-01', 'discovery', true, 0.08, -0.01, 0.05],
            [iids[1]!, '2023-05-01', 'holdout', false, 0.01, -0.04, -0.02],
          ] as [string, string, 'discovery' | 'holdout', boolean, number, number, number][],
        },
      ],
    };
    for (const key of ['scan:a', 'scan:b'])
      await asUser(admin, (tx) =>
        queueCompanionPush(tx, who, { kind: 'pattern_scan_result', clientKey: key, payload }),
      );
    const applied = await apply();
    expect(applied.map((a) => a.result)).toEqual([
      { scan: scanId, status: 'done', patterns: 1 },
      { skipped: 'scan already done' },
    ]);
    const [scan] = await t.research!.owner.db.execute<{ status: string; verified: number }>(
      sql`select status, verified from pattern_scan where id = ${scanId}`,
    );
    expect(scan).toEqual({ status: 'done', verified: 1 });
    // The patterns and occurrences belong to whoever queued the scan, not the producer.
    const occ = await t.research!.owner.db.execute<{ user_id: string; window: string }>(
      sql`select user_id::text, "window" from pattern_occurrence where pattern_id = ${patternId} order by as_of`,
    );
    expect(occ).toEqual([
      { user_id: member, window: 'discovery' },
      { user_id: member, window: 'holdout' },
    ]);
  });

  it('puts a scan left running two days back in the queue, and still takes its result (ADR 0121)', async () => {
    const who = { connectionId: adminConn, userId: admin };
    const r = t.research!.owner.db;
    const stalled = randomUUID();
    const fresh = randomUUID();
    await r.execute(sql`
      insert into pattern_scan (id, user_id, config, summary, status, started_at) values
        (${stalled}, ${member}, '{}'::jsonb, 'Away', 'running', now() - interval '49 hours'),
        (${fresh}, ${member}, '{}'::jsonb, 'Busy', 'running', now() - interval '47 hours')`);
    expect(await releaseStalledPatternScans(t.research!.worker.db)).toEqual([stalled]);
    const rows = await r.execute<{ id: string; status: string }>(
      sql`select id::text, status from pattern_scan where id in (${stalled}, ${fresh}) order by summary`,
    );
    expect(Object.fromEntries(rows.map((x) => [x.id, x.status]))).toEqual({
      [stalled]: 'queued',
      [fresh]: 'running',
    });
    // The companion comes back with the result after all: it is taken.
    await asUser(admin, (tx) =>
      queueCompanionPush(tx, who, {
        kind: 'pattern_scan_result',
        clientKey: `scan:${stalled}`,
        payload: {
          scan: {
            id: stalled,
            status: 'done',
            error: null,
            candidatesTested: 10,
            finalists: 0,
            verified: 0,
            effective: null,
            codeVersion: 'companion',
            seconds: 1,
          },
          patterns: [],
        },
      }),
    );
    expect((await apply()).map((a) => a.result)).toEqual([
      { scan: stalled, status: 'done', patterns: 0 },
    ]);
    await r.execute(sql`update pattern_scan set status = 'done' where id = ${fresh}`);
  });

  it('takes a big scan in parts, and sets its outcome only with the last part (N350)', async () => {
    const who = { connectionId: adminConn, userId: admin };
    const r = t.research!.owner.db;
    const scanId = randomUUID();
    await r.execute(sql`
      insert into pattern_scan (id, user_id, config, summary, status, started_at) values
        (${scanId}, ${member}, '{}'::jsonb, 'Big one', 'running', now())`);
    const patternId = randomUUID();
    const summary = {
      id: scanId,
      status: 'done' as const,
      error: null,
      candidatesTested: 50,
      finalists: 1,
      verified: 1,
      effective: null,
      codeVersion: 'companion',
      seconds: 2,
    };
    const pattern = (occ: [string, string][]) => ({
      id: patternId,
      rank: 1,
      rule: [{ factor: 'rsi_14', op: '<', value: 30 }],
      stats: { holdout: { n: 2 } },
      status: 'verified' as const,
      occurrences: occ.map(
        ([iid, day]) =>
          [iid, day, 'discovery', true, 0.05, -0.01, 0.02] as [
            string,
            string,
            'discovery' | 'holdout',
            boolean,
            number,
            number,
            number,
          ],
      ),
    });
    const parts = [
      {
        key: `scan:${scanId}:p0`,
        payload: { scan: summary, patterns: [pattern([[iids[0]!, '2021-01-04']])], partial: true },
      },
      // The same part again (a retry) changes nothing.
      {
        key: `scan:${scanId}:p0:retry`,
        payload: { scan: summary, patterns: [pattern([[iids[0]!, '2021-01-04']])], partial: true },
      },
      {
        key: `scan:${scanId}`,
        payload: { scan: summary, patterns: [pattern([[iids[1]!, '2021-01-05']])] },
      },
    ];
    for (const part of parts) {
      await asUser(admin, (tx) =>
        queueCompanionPush(tx, who, {
          kind: 'pattern_scan_result',
          clientKey: part.key,
          payload: part.payload,
        }),
      );
      const [applied] = await apply();
      const [scan] = await r.execute<{ status: string }>(
        sql`select status from pattern_scan where id = ${scanId}`,
      );
      if (part.payload.partial) {
        expect(applied!.result).toEqual({ scan: scanId, part: true, patterns: 1 });
        expect(scan!.status).toBe('running');
      } else {
        expect(applied!.result).toEqual({ scan: scanId, status: 'done', patterns: 1 });
        expect(scan!.status).toBe('done');
      }
    }
    const occ = await r.execute<{ n: number }>(
      sql`select count(*)::int as n from pattern_occurrence where pattern_id = ${patternId}`,
    );
    expect(occ[0]!.n).toBe(2);
  });

  it('lists Verified patterns due a decay score and applies the companion’s score (ADR 0121)', async () => {
    const who = { connectionId: adminConn, userId: admin };
    const r = t.research!.owner.db;
    const scanId = randomUUID();
    const due = randomUUID();
    const recent = randomUUID();
    await r.execute(sql`
      insert into pattern_scan (id, user_id, config, summary, status, effective) values
        (${scanId}, ${member}, '{"horizon": 5}'::jsonb, 'Decay scan', 'done',
         '{"to": "2026-06-30", "discoveryEnd": "2025-12-31"}'::jsonb)`);
    await r.execute(sql`
      insert into pattern (id, scan_id, user_id, rank, rule, stats, status, decay_state, decay_stats, last_scored) values
        (${due}, ${scanId}, ${member}, 1, '[]'::jsonb, '{}'::jsonb, 'verified', 'holding',
         '{"reverifyRequestedAt": "2026-11-20T10:00:00Z"}'::jsonb, '2026-11-01'),
        (${recent}, ${scanId}, ${member}, 2, '[]'::jsonb, '{}'::jsonb, 'verified', 'holding', '{}'::jsonb, '2026-11-24')`);
    const answer = await patternsDueForDecay(t.research!.worker.db, '2026-11-26');
    const mine = answer.patterns.filter((p) => p.scan.id === scanId);
    expect(mine.map((p) => p.id)).toEqual([due]);
    expect(mine[0]).toMatchObject({
      userId: member,
      lastScored: '2026-11-01',
      scan: { effective: { to: '2026-06-30' }, config: { horizon: 5 } },
    });
    // The score arrives in two parts; a re-verify asked for again since stays asked for.
    await r.execute(sql`
      update pattern set decay_stats = '{"reverifyRequestedAt": "2026-11-25T09:00:00Z"}'::jsonb where id = ${due}`);
    const occ = (asOf: string) => [iids[0]!, asOf, true, 0.05, -0.01, 0.03] as const;
    await asUser(admin, (tx) =>
      queueCompanionPush(tx, who, {
        kind: 'pattern_decay',
        clientKey: `decay:${due}:p0`,
        payload: { patternId: due, occurrences: [occ('2026-11-10')] },
      }),
    );
    await asUser(admin, (tx) =>
      queueCompanionPush(tx, who, {
        kind: 'pattern_decay',
        clientKey: `decay:${due}`,
        payload: {
          patternId: due,
          occurrences: [occ('2026-11-10'), occ('2026-11-17')],
          state: {
            decayState: 'weakening',
            decayStats: {
              fresh: { n: 2 },
              reverify: { verified: true, requestedAt: '2026-11-20T10:00:00Z' },
            },
            lastScored: '2026-11-25',
          },
        },
      }),
    );
    const twoParts = await apply();
    expect(twoParts.map((a) => a.error)).toEqual([undefined, undefined]);
    expect(twoParts.map((a) => a.result)).toEqual([
      { pattern: due, occurrences: 1 },
      { pattern: due, occurrences: 2, state: 'weakening', lastScored: '2026-11-25' },
    ]);
    const [row] = await r.execute<{
      decay_state: string;
      decay_stats: Record<string, unknown>;
      last_scored: string;
    }>(sql`select decay_state, decay_stats, last_scored::text from pattern where id = ${due}`);
    expect(row).toEqual({
      decay_state: 'weakening',
      decay_stats: {
        fresh: { n: 2 },
        reverify: { verified: true, requestedAt: '2026-11-20T10:00:00Z' },
        reverifyRequestedAt: '2026-11-25T09:00:00Z',
      },
      last_scored: '2026-11-25',
    });
    const fresh = await r.execute<{ as_of: string; user_id: string }>(
      sql`select as_of::text, user_id::text from pattern_occurrence where pattern_id = ${due} and "window" = 'fresh' order by as_of`,
    );
    expect(fresh).toEqual([
      { as_of: '2026-11-10', user_id: member },
      { as_of: '2026-11-17', user_id: member },
    ]);
    // An older score never replaces a newer one.
    await asUser(admin, (tx) =>
      queueCompanionPush(tx, who, {
        kind: 'pattern_decay',
        clientKey: `decay:${due}:old`,
        payload: {
          patternId: due,
          occurrences: [],
          state: { decayState: 'holding', decayStats: {}, lastScored: '2026-11-18' },
        },
      }),
    );
    expect((await apply()).map((a) => a.result)).toEqual([
      { pattern: due, occurrences: 0, skipped: 'scored since' },
    ]);
  });

  it('A4: with the companion away 48 hours, research says paused and trading still reads what was delivered', async () => {
    const r = t.research!.owner.db;
    const reads = new Map([['mf-ranker-ridge', new Set(iids)]]);
    const before = await loadMlPredictions(t.worker.db, reads);
    expect(before.get('mf-ranker-ridge')!.size).toBeGreaterThan(0);
    const stalled = randomUUID();
    await r.execute(sql`
      insert into pattern_scan (id, user_id, config, summary, status, started_at) values
        (${stalled}, ${member}, '{}'::jsonb, 'Taken, then away', 'running', now() - interval '1 hour')`);
    // Two days and a minute later, with no hello and no push in between.
    const later = new Date(Date.now() + COMPANION_OFFLINE_AFTER_MS + 60_000);
    const status = await asUser(member, (tx) =>
      researchStorageStatus(tx, { mode: 'companion', producerUserId: admin, now: later }),
    );
    expect(status).toMatchObject({ mode: 'companion', connected: false });
    // The scores the paper runtime and back tests read are the last ones delivered, unchanged.
    expect(await loadMlPredictions(t.worker.db, reads)).toEqual(before);
    // The scan it took goes back in the queue once it has been gone that long.
    expect(await releaseStalledPatternScans(t.research!.worker.db)).not.toContain(stalled);
    await r.execute(
      sql`update pattern_scan set started_at = now() - interval '48 hours 1 minute' where id = ${stalled}`,
    );
    expect(await releaseStalledPatternScans(t.research!.worker.db)).toEqual([stalled]);
    await r.execute(sql`update pattern_scan set status = 'failed' where id = ${stalled}`);
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
