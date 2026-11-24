import {
  createTokenConnection,
  pairCompanion,
  revokeAgentConnection,
  schema,
  withTenant,
  type Transaction,
} from '@tm/db';
import { createTestDatabase, type TestDatabase } from '@tm/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleMcpRequest } from '@/lib/server/agents/mcp';
import { handleHello, handleInstruments, handleMembership } from '@/lib/server/companion/api';

/**
 * The Local Companion API (storage separation S2, ADR 0116): only a
 * research_sync pairing gets in, and that pairing gets nothing from the AI
 * agent endpoint.
 */

const APP_URL = 'https://app.example.test';
let t: TestDatabase;
let userA: string;
let companionToken: string;
let companionId: string;
let agentToken: string;

const as = <T>(userId: string, fn: (tx: Transaction) => Promise<T>) =>
  withTenant(t.app.db, { userId }, fn);

const req = (path: string, token: string | null, body?: unknown) =>
  new Request(`${APP_URL}/api/companion/v1/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

beforeAll(async () => {
  t = await createTestDatabase();
  const [row] = await t.auth.db
    .insert(schema.users)
    .values({ name: 'companion', email: 'companion-web@example.com' })
    .returning({ id: schema.users.id });
  userA = row!.id;
  const paired = await as(userA, (tx) => pairCompanion(tx, userA));
  companionToken = paired.token;
  companionId = paired.connection.id;
  agentToken = (
    await as(userA, (tx) =>
      createTokenConnection(tx, userA, {
        profileId: 'claude-code',
        name: 'Agent',
        scope: 'operate',
        expiry: 'none',
      }),
    )
  ).token;
});

afterAll(async () => {
  await t?.drop();
});

describe('Local Companion API (ADR 0116)', () => {
  it('says hello with a pairing token', async () => {
    const r = await handleHello(
      req('hello', companionToken, { version: '0.1.0', platform: 'darwin-arm64' }),
      {
        db: t.app.db,
      },
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { connectionId: string; seenAt: string };
    expect(body.connectionId).toBe(companionId);
    expect(Date.parse(body.seenAt)).not.toBeNaN();
  });

  it('refuses no token, a bad body and an AI agent token', async () => {
    expect((await handleHello(req('hello', null, {}), { db: t.app.db })).status).toBe(401);
    expect(
      (await handleHello(req('hello', companionToken, { version: '' }), { db: t.app.db })).status,
    ).toBe(400);
    const r = await handleInstruments(req('instruments', agentToken), { db: t.app.db });
    expect(r.status).toBe(401);
  });

  it('pulls reference data', async () => {
    const r = await handleInstruments(req('instruments', companionToken), { db: t.app.db });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { instruments: unknown[]; next: string | null };
    expect(Array.isArray(body.instruments)).toBe(true);
    expect(
      (await handleInstruments(req('instruments?after=x', companionToken), { db: t.app.db }))
        .status,
    ).toBe(400);
    const m = await handleMembership(req('membership', companionToken), { db: t.app.db });
    expect(m.status).toBe(200);
  });

  it('a pairing token is refused by the AI agent endpoint', async () => {
    const r = await handleMcpRequest(
      new Request(`${APP_URL}/api/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${companionToken}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      }),
      { db: t.app.db, appUrl: APP_URL, enabled: true, sleep: async () => undefined },
    );
    expect(r.status).toBe(401);
  });

  it('stops working once unpaired', async () => {
    await as(userA, (tx) => revokeAgentConnection(tx, userA, companionId));
    const r = await handleHello(req('hello', companionToken, { version: '0.1.0', platform: 'x' }), {
      db: t.app.db,
    });
    expect(r.status).toBe(401);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('connection_revoked');
  });
});
