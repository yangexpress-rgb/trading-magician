import {
  createTokenConnection,
  hashAgentSecret,
  listAgentCalls,
  revokeAgentConnection,
  schema,
  sql,
  withTenant,
  type Transaction,
} from '@tm/db';
import { createTestDatabase, type TestDatabase } from '@tm/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleMcpRequest } from '@/lib/server/agents/mcp';

/**
 * Agent connections end to end (Bring your own AI agent brief §6, ADR 0092):
 * tokens, the MCP endpoint, scopes and the activity log, against a real
 * database with the app's own roles and row-level security.
 */

const APP_URL = 'https://app.example.test';
let t: TestDatabase;
let userA: string;
let userB: string;
let demoA: string;

const as = <T>(userId: string, fn: (tx: Transaction) => Promise<T>) =>
  withTenant(t.app.db, { userId }, fn);

async function createUser(email: string): Promise<string> {
  const [row] = await t.auth.db
    .insert(schema.users)
    .values({ name: email.split('@')[0] ?? email, email })
    .returning({ id: schema.users.id });
  if (!row) throw new Error('user insert failed');
  return row.id;
}

let rpcId = 0;
async function mcp(
  token: string | null,
  method: string,
  params: Record<string, unknown> = {},
  options: { enabled?: boolean } = {},
) {
  const response = await handleMcpRequest(
    new Request(`${APP_URL}/api/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    }),
    {
      db: t.app.db,
      appUrl: APP_URL,
      enabled: options.enabled ?? true,
      sleep: async () => undefined,
    },
  );
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON-RPC bodies, read loosely in tests
    body: text ? (JSON.parse(text) as Record<string, any>) : null,
  };
}

/** A tools/call's parsed result and whether it was an error. */
async function call(token: string, name: string, args: Record<string, unknown> = {}) {
  const r = await mcp(token, 'tools/call', { name, arguments: args });
  expect(r.status).toBe(200);
  const result = r.body?.result as { content: { text: string }[]; isError?: boolean };
  return { isError: result.isError === true, data: JSON.parse(result.content[0]!.text) };
}

async function mint(userId: string, scope: 'read' | 'operate', expiry: 'none' | '90d' = 'none') {
  return as(userId, (tx) =>
    createTokenConnection(tx, userId, { profileId: 'claude-code', name: 'Test', scope, expiry }),
  );
}

/** Long DEMO-A when its close is above its 20-day SMA; exit below it. */
function simpleDefinition(account: string) {
  const series = {
    instrumentId: demoA,
    field: 'close',
    interval: '1d',
    adjustment: 'split_and_dividend',
    session: 'regular',
    offset: 0,
  };
  const leg = {
    instrumentId: demoA,
    accountId: account,
    quantity: { type: 'units', value: '10', rounding: 'down' },
    orderType: 'market',
    timeInForce: 'day',
    timing: { mode: 'immediate' },
  };
  return {
    schemaVersion: 5,
    trade: { kind: 'assets' },
    entry: {
      condition: {
        kind: 'group',
        id: 'g1',
        op: 'and',
        negate: false,
        children: [
          {
            kind: 'comparison',
            id: 'c1',
            operator: 'gt',
            left: { kind: 'market', id: 'px', ...series },
            right: { kind: 'indicator', id: 'sma', name: 'SMA', params: { period: 20 }, ...series },
          },
        ],
      },
      trigger: { mode: 'on_transition', cooldownBars: 0, confirmationBars: 0 },
      orders: [{ id: 'buy', legLabel: 'Buy A', side: 'buy', ...leg }],
    },
    exit: {
      condition: {
        kind: 'group',
        id: 'g2',
        op: 'and',
        negate: false,
        children: [
          {
            kind: 'comparison',
            id: 'c2',
            operator: 'lt',
            left: { kind: 'market', id: 'px2', ...series },
            right: {
              kind: 'indicator',
              id: 'sma2',
              name: 'SMA',
              params: { period: 20 },
              ...series,
            },
          },
        ],
      },
      trigger: { mode: 'on_transition', cooldownBars: 0, confirmationBars: 0 },
      orders: [{ id: 'sell', legLabel: 'Sell A', side: 'sell', ...leg }],
    },
    execution: {
      multiLegPolicy: 'concurrent',
      legTimeoutSec: 60,
      onLegFailure: 'cancel_remaining',
      entryMilestone: 'full_fill',
      reentry: { mode: 'single_cycle' },
      marketHoursPolicy: 'queue',
      holidayCalendar: 'NYSE',
      staleDataSec: 60,
    },
    risk: {
      maxOrderNotional: '10000',
      maxStrategyExposure: '25000',
      maxActiveOrders: 10,
      dailyLossLimit: '1000',
      priceCollarPct: '5',
    },
  };
}

let accountA: string;

beforeAll(async () => {
  t = await createTestDatabase();
  userA = await createUser('a@example.test');
  userB = await createUser('b@example.test');
  const { provisionWorkspace } = await import('@tm/db');
  await provisionWorkspace(t.app.db, { userId: userA, displayName: 'A' });
  await provisionWorkspace(t.app.db, { userId: userB, displayName: 'B' });
  const rows = await t.owner.db.select().from(schema.instruments);
  demoA = rows.find((r) => r.symbol === 'DEMO-A')!.id;
  accountA = (await as(userA, (tx) => tx.select().from(schema.tradingAccounts)))[0]!.id;
}, 60_000);

afterAll(async () => {
  await t?.drop();
});

describe('agent tokens', () => {
  it('stores only a hash and shows the token once', async () => {
    const { token, connection } = await mint(userA, 'read');
    expect(token).toMatch(/^tma_[A-Za-z0-9_-]{43}$/);
    expect(connection.tokenHint).toBe(`tma_…${token.slice(-4)}`);
    const rows =
      await t.ownerSql`select hash, kind from agent_credential where connection_id = ${connection.id}`;
    expect(rows).toEqual([{ hash: hashAgentSecret(token), kind: 'token' }]);
    const all = await t.ownerSql`select * from agent_connection where id = ${connection.id}`;
    expect(JSON.stringify(all)).not.toContain(token);
  });

  it('answers a valid token and refuses missing, wrong, expired and revoked ones', async () => {
    const { token, connection } = await mint(userA, 'read');
    expect((await mint(userA, 'read')).token).not.toBe(token);

    const ok = await mcp(token, 'initialize', { protocolVersion: '2025-06-18' });
    expect(ok.status).toBe(200);
    expect(ok.body?.result.protocolVersion).toBe('2025-06-18');
    expect(ok.body?.result.capabilities).toEqual({ tools: { listChanged: false } });

    const none = await mcp(null, 'tools/list');
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toContain(
      `resource_metadata="${APP_URL}/.well-known/oauth-protected-resource/api/mcp"`,
    );
    expect((await mcp(`${token.slice(0, -1)}x`, 'tools/list')).status).toBe(401);
    expect((await mcp('tma_nothing', 'tools/list')).status).toBe(401);

    const expiring = await mint(userA, 'read', '90d');
    await t.ownerSql`update agent_connection set expires_at = now() - interval '1 second' where id = ${expiring.connection.id}`;
    const expired = await mcp(expiring.token, 'tools/list');
    expect(expired.status).toBe(401);
    expect(expired.body?.error.message).toContain('expired');

    await as(userA, (tx) => revokeAgentConnection(tx, userA, connection.id));
    const revoked = await mcp(token, 'tools/call', { name: 'list_strategies', arguments: {} });
    expect(revoked.status).toBe(401);
    expect(revoked.body?.error.message).toContain('revoked');
    expect(revoked.headers.get('www-authenticate')).toContain('error="invalid_token"');
    // The refused call is in the person's activity, under the tool it named.
    const calls = await as(userA, (tx) => listAgentCalls(tx, { connectionId: connection.id }));
    expect(calls[0]).toMatchObject({
      tool: 'list_strategies',
      outcome: 'refused',
      errorClass: 'connection_revoked',
    });
  });

  it('refuses a token of a deleted account', async () => {
    const userC = await createUser('c@example.test');
    const { provisionWorkspace } = await import('@tm/db');
    await provisionWorkspace(t.app.db, { userId: userC, displayName: 'C' });
    const { token } = await mint(userC, 'read');
    expect((await mcp(token, 'tools/list')).status).toBe(200);
    await t.ownerSql`update "user" set deleted_at = now() where id = ${userC}`;
    expect((await mcp(token, 'tools/list')).status).toBe(401);
  });

  it('is off unless AGENT_API_ENABLED', async () => {
    const { token } = await mint(userA, 'read');
    const off = await mcp(token, 'tools/list', {}, { enabled: false });
    expect(off.status).toBe(503);
    expect(off.body?.error.code).toBe(-32000);
  });

  it("keeps each person's connections and activity to themselves", async () => {
    await mint(userA, 'read');
    const seenByB = await as(userB, (tx) => tx.select().from(schema.agentConnections));
    expect(seenByB.every((c) => c.userId === userB)).toBe(true);
    await expect(
      as(userB, (tx) => tx.execute(sql`select * from agent_credential`)),
    ).rejects.toThrow();
  });
});

describe('scope', () => {
  it('refuses operate tools to a read connection and lets an operate connection use them', async () => {
    const read = await mint(userA, 'read');
    const refused = await call(read.token, 'create_strategy', { name: 'Not allowed' });
    expect(refused.isError).toBe(true);
    expect(refused.data.error.code).toBe('insufficient_scope');
    const count =
      await t.ownerSql`select count(*)::int as n from strategy where name = 'Not allowed'`;
    expect(count[0]!.n).toBe(0);

    const operate = await mint(userA, 'operate');
    const made = await call(operate.token, 'create_strategy', {
      name: 'Made by an agent',
      definition: simpleDefinition(accountA),
    });
    expect(made.isError).toBe(false);
    expect(made.data.number).toMatch(/^S\d{5}-/);
    expect(made.data.validation.canRun).toBe(true);
  });
});

describe('tools', () => {
  it('lists strategies, creates one, reads it back and queues a back test', async () => {
    const { token } = await mint(userA, 'operate');
    const before = (await call(token, 'list_strategies')).data.total as number;

    const made = await call(token, 'create_strategy', {
      name: 'Agent SMA test',
      definition: simpleDefinition(accountA),
    });
    expect(made.isError).toBe(false);
    const after = await call(token, 'list_strategies');
    expect(after.data.total).toBe(before + 1);

    const got = await call(token, 'get_strategy', { strategy: made.data.number });
    expect(got.isError).toBe(false);
    expect(got.data.id).toBe(made.data.id);
    expect(got.data.summary.join('\n')).toContain('What to trade: DEMO-A.');
    expect(got.data.summary.join('\n')).toContain(
      'Entry when: DEMO-A close > SMA(20) of DEMO-A close',
    );
    expect(got.data.definition.entry.orders).toHaveLength(1);

    const run = await call(token, 'run_backtest', {
      strategy: made.data.id,
      endDate: '2026-09-30',
      lookBack: '3m',
    });
    expect(run.isError).toBe(false);
    expect(run.data.status).toBe('queued');
    expect(run.data.inputs).toMatchObject({ from: '2026-06-30', to: '2026-09-30', interval: '1d' });

    const listed = await call(token, 'list_backtests', { strategy: made.data.number });
    expect(listed.data.runs.map((r: { id: string }) => r.id)).toContain(run.data.runId);
    const read = await call(token, 'get_backtest', { runId: run.data.runId });
    expect(read.data).toMatchObject({ status: 'queued', cycles: { total: 0, items: [] } });
  });

  it('returns the validation errors the app shows for an invalid definition, and creates nothing', async () => {
    const { token } = await mint(userA, 'operate');
    const before = await t.ownerSql`select count(*)::int as n from strategy`;
    const bad = await call(token, 'create_strategy', {
      name: 'Broken',
      definition: { schemaVersion: 5, trade: { kind: 'assets' } },
    });
    expect(bad.isError).toBe(true);
    expect(bad.data.error.code).toBe('invalid_definition');
    expect(bad.data.error.message).toBe(
      'The strategy definition is not in a format this version understands',
    );
    expect(bad.data.error.issues.length).toBeGreaterThan(0);
    expect(bad.data.error.issues[0]).toHaveProperty('path');
    const after = await t.ownerSql`select count(*)::int as n from strategy`;
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it('finds theories and reads one', async () => {
    const { token } = await mint(userA, 'read');
    const found = await call(token, 'search_theories', { limit: 3 });
    expect(found.data.total).toBeGreaterThan(0);
    expect(found.data.items).toHaveLength(3);
    const one = await call(token, 'get_theory', { number: found.data.items[0].number });
    expect(one.data.registrationNumber).toBe(found.data.items[0].number);
    const missing = await call(token, 'get_theory', { number: 'T99999-ZZ' });
    expect(missing).toMatchObject({ isError: true, data: { error: { code: 'not_found' } } });
  });

  it('reads paper accounts', async () => {
    const { token } = await mint(userA, 'read');
    const r = await call(token, 'get_paper_accounts');
    expect(r.isError).toBe(false);
    expect(
      r.data.platforms.flatMap((p: { accounts: unknown[] }) => p.accounts).length,
    ).toBeGreaterThan(0);
  });

  it('answers a bad argument with the field and an unknown tool with a protocol error', async () => {
    const { token } = await mint(userA, 'read');
    const bad = await call(token, 'get_backtest', { runId: 'nope' });
    expect(bad.isError).toBe(true);
    expect(bad.data.error.issues[0].path).toEqual(['runId']);
    const unknown = await mcp(token, 'tools/call', { name: 'place_order', arguments: {} });
    expect(unknown.body?.error.code).toBe(-32602);
  });
});

describe('activity log', () => {
  it('records successful, failed and refused calls, without secrets', async () => {
    const read = await mint(userB, 'read');
    await call(read.token, 'list_strategies', { query: 'x' });
    await call(read.token, 'get_theory', { number: 'T99999-ZZ' });
    await call(read.token, 'create_strategy', { name: 'No', apiKey: 'hunter2' });
    const calls = await as(userB, (tx) => listAgentCalls(tx, { connectionId: read.connection.id }));
    expect(calls.map((c) => [c.tool, c.outcome, c.errorClass])).toEqual([
      ['create_strategy', 'refused', 'insufficient_scope'],
      ['get_theory', 'error', 'not_found'],
      ['list_strategies', 'ok', null],
    ]);
    expect(calls[2]!.args).toEqual({ query: 'x' });
    expect(calls[0]!.args).toEqual({ name: 'No' });
    expect(calls[0]!.connectionName).toBe('Test');
    // Person A never sees B's activity.
    const seenByA = await as(userA, (tx) =>
      listAgentCalls(tx, { connectionId: read.connection.id }),
    );
    expect(seenByA).toEqual([]);
  });

  it('rate limits each connection to 60 calls a minute', async () => {
    const { token, connection } = await mint(userB, 'read');
    await t.ownerSql`select rate_limit_hit(${`agent:${connection.id}`}, 1000, 60) from generate_series(1, 60)`;
    const r = await call(token, 'list_strategies');
    expect(r).toMatchObject({ isError: true, data: { error: { code: 'rate_limited' } } });
  });
});

describe('OAuth 2.1', () => {
  const deps = () => ({ db: t.app.db, appUrl: APP_URL, enabled: true });
  const form = (body: Record<string, string>) =>
    new Request(`${APP_URL}/api/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    });

  it('runs the grant, a call, a refresh and a revocation', async () => {
    const {
      handleRegister,
      handleToken,
      handleRevoke,
      checkAuthorize,
      authorizationServerMetadata,
    } = await import('@/lib/server/agents/oauth');
    const { createOAuthCode, pkceChallenge } = await import('@tm/db');

    expect(authorizationServerMetadata(APP_URL)).toMatchObject({
      issuer: APP_URL,
      code_challenge_methods_supported: ['S256'],
      registration_endpoint: `${APP_URL}/api/oauth/register`,
    });

    // 1. The agent registers itself.
    const reg = await handleRegister(
      new Request(`${APP_URL}/api/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Claude',
          redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
          token_endpoint_auth_method: 'none',
        }),
      }),
      deps(),
    );
    expect(reg.status).toBe(201);
    const client = (await reg.json()) as { client_id: string; client_secret?: string };
    expect(client.client_secret).toBeUndefined();

    // 2. The person signs in and approves on the consent screen.
    const verifier = 'v'.repeat(20) + 'erifier-0123456789-abcdefghijkl';
    const check = await checkAuthorize(t.app.db, APP_URL, {
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: 'S256',
      state: 'xyz',
      scope: 'read operate',
      resource: `${APP_URL}/api/mcp`,
    });
    if (!check.ok) throw new Error(check.message);
    expect(check.request.profile.id).toBe('claude');
    expect(check.request.operateRequested).toBe(true);
    const code = await as(userA, (tx) =>
      createOAuthCode(tx, userA, {
        clientRowId: check.request.client.id,
        redirectUri: check.request.redirectUri,
        codeChallenge: check.request.codeChallenge,
        scope: 'operate',
        profileId: check.request.profile.id,
      }),
    );

    // A wrong verifier is refused and spends nothing.
    const wrong = await handleToken(
      form({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        code,
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        code_verifier: 'w'.repeat(43),
      }),
      deps(),
    );
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { error: string }).error).toBe('invalid_grant');

    // 3. The agent exchanges the code.
    const tokenRes = await handleToken(
      form({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        code,
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        code_verifier: verifier,
      }),
      deps(),
    );
    expect(tokenRes.status).toBe(200);
    const tokens = (await tokenRes.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      scope: string;
    };
    expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'operate' });
    expect(tokens.access_token).toMatch(/^tmo_at_/);

    // 4. It calls a read tool and an operate tool.
    expect((await call(tokens.access_token, 'list_strategies')).isError).toBe(false);
    const made = await call(tokens.access_token, 'create_strategy', { name: 'Via OAuth' });
    expect(made.isError).toBe(false);
    const conns = await as(userA, (tx) => tx.select().from(schema.agentConnections));
    const conn = conns.find((c) => c.authMethod === 'oauth')!;
    expect(conn).toMatchObject({ profileId: 'claude', name: 'Claude', scope: 'operate' });

    // A code works once; replaying it revokes what it made.
    const replay = await handleToken(
      form({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        code,
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        code_verifier: verifier,
      }),
      deps(),
    );
    expect(replay.status).toBe(400);
    expect((await mcp(tokens.access_token, 'tools/list')).status).toBe(401);
    await t.ownerSql`update agent_connection set revoked_at = null where id = ${conn.id}`;

    // 5. Refresh rotates: the new pair works, the old refresh token does not.
    const refreshed = await handleToken(
      form({
        grant_type: 'refresh_token',
        client_id: client.client_id,
        refresh_token: tokens.refresh_token,
      }),
      deps(),
    );
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as { access_token: string; refresh_token: string };
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    expect((await call(next.access_token, 'list_strategies')).isError).toBe(false);
    const reuse = await handleToken(
      form({
        grant_type: 'refresh_token',
        client_id: client.client_id,
        refresh_token: tokens.refresh_token,
      }),
      deps(),
    );
    expect(reuse.status).toBe(400);
    // A refresh token is not an access token.
    expect((await mcp(next.refresh_token, 'tools/list')).status).toBe(401);

    // 6. Revocation ends the connection for both tokens.
    const revoked = await handleRevoke(
      new Request(`${APP_URL}/api/oauth/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          token: next.refresh_token,
          client_id: client.client_id,
        }).toString(),
      }),
      deps(),
    );
    expect(revoked.status).toBe(200);
    expect((await mcp(next.access_token, 'tools/list')).status).toBe(401);
    const again = await handleToken(
      form({
        grant_type: 'refresh_token',
        client_id: client.client_id,
        refresh_token: next.refresh_token,
      }),
      deps(),
    );
    expect(again.status).toBe(400);
  });

  it('attributes a client calling back to agent.meta.ai to Muse (N271)', async () => {
    const { handleRegister, handleToken, checkAuthorize } =
      await import('@/lib/server/agents/oauth');
    const { profileName } = await import('@/lib/agents/profiles');
    const { createOAuthCode, pkceChallenge } = await import('@tm/db');
    const redirect = 'https://agent.meta.ai/oauth/callback';
    // A generic client name: the callback host alone decides.
    const reg = await handleRegister(
      new Request(`${APP_URL}/api/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: 'MCP Client',
          redirect_uris: [redirect],
          token_endpoint_auth_method: 'none',
        }),
      }),
      deps(),
    );
    expect(reg.status).toBe(201);
    const client = (await reg.json()) as { client_id: string };
    const verifier = 'm'.repeat(20) + 'use-verifier-0123456789-abcdefg';
    const check = await checkAuthorize(t.app.db, APP_URL, {
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: redirect,
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: 'S256',
      scope: 'read',
    });
    if (!check.ok) throw new Error(check.message);
    expect(check.request.profile.id).toBe('muse');
    const code = await as(userB, (tx) =>
      createOAuthCode(tx, userB, {
        clientRowId: check.request.client.id,
        redirectUri: check.request.redirectUri,
        codeChallenge: check.request.codeChallenge,
        scope: 'read',
        profileId: check.request.profile.id,
      }),
    );
    const tokenRes = await handleToken(
      form({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        code,
        redirect_uri: redirect,
        code_verifier: verifier,
      }),
      deps(),
    );
    expect(tokenRes.status).toBe(200);
    const conns = await as(userB, (tx) => tx.select().from(schema.agentConnections));
    const conn = conns.find((c) => c.authMethod === 'oauth')!;
    expect(conn).toMatchObject({ profileId: 'muse', scope: 'read' });
    expect(profileName(conn.profileId)).toBe('Muse');
  });

  it('refuses unregistered redirect URIs, plain PKCE and other resources', async () => {
    const { handleRegister, checkAuthorize } = await import('@/lib/server/agents/oauth');
    const bad = await handleRegister(
      new Request(`${APP_URL}/api/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_name: 'X', redirect_uris: ['http://evil.example/cb'] }),
      }),
      deps(),
    );
    expect(bad.status).toBe(400);
    const reg = await handleRegister(
      new Request(`${APP_URL}/api/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: 'ChatGPT',
          redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
          token_endpoint_auth_method: 'client_secret_post',
        }),
      }),
      deps(),
    );
    const client = (await reg.json()) as { client_id: string; client_secret: string };
    expect(client.client_secret).toMatch(/^tmcs_/);
    const base = {
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
      code_challenge: 'a'.repeat(43),
      code_challenge_method: 'S256',
    };
    const ok = await checkAuthorize(t.app.db, APP_URL, base);
    expect(ok.ok && ok.request.profile.id).toBe('chatgpt');
    expect(ok.ok && ok.request.operateRequested).toBe(true);
    const readOnly = await checkAuthorize(t.app.db, APP_URL, { ...base, scope: 'read' });
    expect(readOnly.ok && readOnly.request.operateRequested).toBe(false);
    const elsewhere = await checkAuthorize(t.app.db, APP_URL, {
      ...base,
      redirect_uri: 'https://evil.example/cb',
    });
    expect(elsewhere).toMatchObject({ ok: false, redirect: null });
    const plain = await checkAuthorize(t.app.db, APP_URL, {
      ...base,
      code_challenge_method: 'plain',
    });
    expect(plain.ok).toBe(false);
    expect(!plain.ok && plain.redirect).toContain('error=invalid_request');
    const other = await checkAuthorize(t.app.db, APP_URL, {
      ...base,
      resource: 'https://other.example/mcp',
    });
    expect(!other.ok && other.redirect).toContain('error=invalid_target');
    // A confidential client must send its secret.
    const { handleToken } = await import('@/lib/server/agents/oauth');
    const noSecret = await handleToken(
      form({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: 'x' }),
      deps(),
    );
    expect(noSecret.status).toBe(401);
  });
});
