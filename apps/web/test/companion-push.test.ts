import { randomUUID } from 'node:crypto';
import { pairCompanion, schema, withTenant, type Transaction } from '@tm/db';
import { createTestDatabase, type TestDatabase } from '@tm/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  handleFetch,
  handleFetchAnswer,
  handleMlState,
  handlePush,
  handlePushes,
  handleRunPredictions,
} from '@/lib/server/companion/api';

/**
 * Frozen Output pushes through the companion API (ADR 0117): only the
 * producer's companion may queue them, payloads are checked, and a repeated
 * push is the same push.
 */

const APP_URL = 'https://app.example.test';
let t: TestDatabase;
let adminToken: string;
let memberToken: string;
let iid: string;

const as = <T>(userId: string, fn: (tx: Transaction) => Promise<T>) =>
  withTenant(t.app.db, { userId }, fn);

const req = (path: string, token: string, body?: unknown) =>
  new Request(`${APP_URL}/api/companion/v1/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function user(email: string) {
  const [row] = await t.auth.db
    .insert(schema.users)
    .values({ name: email, email })
    .returning({ id: schema.users.id });
  return row!.id;
}

const runPayload = () => ({
  run: {
    id: randomUUID(),
    modelKey: 'mf-ranker-ridge',
    predictionDate: '2021-01-29',
    trainingStart: '2015-01-30',
    trainingEnd: '2020-11-30',
    maxLabelEnd: '2020-12-30',
    rowsTrained: 100,
    crossSections: 20,
    hyperparams: { alpha: 10 },
    coefficients: { mom_12_1: 0.1 },
    codeVersion: 'test',
  },
  predictions: [[iid, 0.5]],
});

beforeAll(async () => {
  t = await createTestDatabase();
  const admin = await user('push-admin@example.com');
  const member = await user('push-member@example.com');
  await t.ownerSql`insert into platform_admin (user_id) values (${admin})`;
  adminToken = (await as(admin, (tx) => pairCompanion(tx, admin))).token;
  memberToken = (await as(member, (tx) => pairCompanion(tx, member))).token;
  const [i] = await t.owner.db
    .select({ id: schema.instruments.id })
    .from(schema.instruments)
    .limit(1);
  iid = i!.id;
});

afterAll(async () => {
  await t?.drop();
});

describe('Companion pushes (ADR 0117)', () => {
  it('queues a run from the producer once', async () => {
    const payload = runPayload();
    const body = { kind: 'ml_run', clientKey: `run:${payload.run.id}`, payload };
    const first = await handlePush(req('pushes', adminToken, body), { db: t.app.db });
    expect(first.status).toBe(202);
    const { pushId } = (await first.json()) as { pushId: string };
    const again = await handlePush(req('pushes', adminToken, body), { db: t.app.db });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ pushId, duplicate: true });
    const list = await handlePushes(req('pushes?open=1', adminToken), { db: t.app.db });
    expect(((await list.json()) as { pushes: { id: string }[] }).pushes.map((p) => p.id)).toEqual([
      pushId,
    ]);
  });

  it('refuses a member’s companion and a malformed payload', async () => {
    const payload = runPayload();
    const member = await handlePush(
      req('pushes', memberToken, { kind: 'ml_run', clientKey: 'run:x', payload }),
      { db: t.app.db },
    );
    expect(member.status).toBe(403);
    expect(await member.json()).toMatchObject({ error: { code: 'not_producer' } });
    const bad = await handlePush(
      req('pushes', adminToken, { kind: 'ml_run', clientKey: 'run:y', payload: { run: {} } }),
      { db: t.app.db },
    );
    expect(bad.status).toBe(400);
    const kind = await handlePush(
      req('pushes', adminToken, { kind: 'trade', clientKey: 'z', payload: {} }),
      { db: t.app.db },
    );
    expect(kind.status).toBe(400);
  });

  it('serves the model registry and a run’s predictions', async () => {
    const state = await handleMlState(req('ml/state', memberToken), { db: t.app.db });
    expect(state.status).toBe(200);
    const body = (await state.json()) as { models: { modelKey: string }[]; runs: unknown[] };
    expect(body.models.map((m) => m.modelKey)).toContain('mf-ranker-ridge');
    const none = await handleRunPredictions(
      req(`ml/runs/${randomUUID()}/predictions`, adminToken),
      { db: t.app.db },
      randomUUID(),
    );
    expect(await none.json()).toEqual({ predictions: [] });
    const bad = await handleRunPredictions(
      req('ml/runs/x/predictions', adminToken),
      { db: t.app.db },
      'x',
    );
    expect(bad.status).toBe(400);
  });

  it('queues a data request from the producer and hands its answer over once (ADR 0118)', async () => {
    const sent = await handleFetch(
      req('fetches', adminToken, { kind: 'members', request: { universe: 'sp500' } }),
      { db: t.app.db },
    );
    expect(sent.status).toBe(202);
    const { fetchId } = (await sent.json()) as { fetchId: string };
    const pending = await handleFetchAnswer(
      req(`fetches/${fetchId}`, adminToken),
      { db: t.app.db },
      fetchId,
    );
    expect(await pending.json()).toEqual({ status: 'pending' });
    await t.owner.db
      .update(schema.companionFetches)
      .set({ answeredAt: new Date(), answer: { ids: [], refs: [] } });
    const done = await handleFetchAnswer(
      req(`fetches/${fetchId}`, adminToken),
      { db: t.app.db },
      fetchId,
    );
    expect(await done.json()).toEqual({ status: 'done', answer: { ids: [], refs: [] } });
    const gone = await handleFetchAnswer(
      req(`fetches/${fetchId}`, adminToken),
      { db: t.app.db },
      fetchId,
    );
    expect(gone.status).toBe(404);
  });

  it('refuses a member’s data request and a malformed one', async () => {
    const member = await handleFetch(
      req('fetches', memberToken, { kind: 'members', request: { universe: 'sp500' } }),
      { db: t.app.db },
    );
    expect(member.status).toBe(403);
    expect(await member.json()).toMatchObject({ error: { code: 'not_producer' } });
    const bad = await handleFetch(
      req('fetches', adminToken, { kind: 'bars', request: { requests: [] } }),
      { db: t.app.db },
    );
    expect(bad.status).toBe(400);
  });
});
