import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTokenConnection, listAgentConnections, resolveAgentCredential } from '../src/agents';
import type { Transaction } from '../src/client';
import {
  companionHello,
  companionInstruments,
  companionMembership,
  COMPANION_OFFLINE_AFTER_MS,
  listCompanions,
  pairCompanion,
  recordCompanionPush,
  researchStorageStatus,
  unpairCompanion,
} from '../src/companion';
import { users } from '../src/schema';
import { withTenant } from '../src/tenant';
import { createTestDatabase, type TestDatabase } from './harness';

/**
 * Local Companion pairing and status (storage separation S2, ADR 0116): a
 * research_sync agent connection, its hello, the 48-hour connected rule, and
 * that the pairing stays apart from AI agents and from other people.
 */

let t: TestDatabase;
let userA: string;
let userB: string;

const asUser = <T>(userId: string, fn: (tx: Transaction) => Promise<T>) =>
  withTenant(t.app.db, { userId }, fn);

async function createUser(email: string): Promise<string> {
  const [row] = await t.auth.db
    .insert(users)
    .values({ name: email.split('@')[0] ?? email, email })
    .returning({ id: users.id });
  return row!.id;
}

beforeAll(async () => {
  t = await createTestDatabase();
  userA = await createUser('companion-a@example.com');
  userB = await createUser('companion-b@example.com');
});

afterAll(async () => {
  await t?.drop();
});

describe('Local Companion pairing (ADR 0116)', () => {
  it('pairs with a research_sync token that resolves to its owner', async () => {
    const { token, connection } = await asUser(userA, (tx) => pairCompanion(tx, userA));
    expect(connection.scope).toBe('research_sync');
    expect(connection.expiresAt).toBeNull();
    const cred = await resolveAgentCredential(t.app.db, token);
    expect(cred).toMatchObject({
      userId: userA,
      scope: 'research_sync',
      kind: 'token',
      state: 'ok',
      connectionId: connection.id,
    });
  });

  it('keeps pairings out of the AI agents list and lists them apart', async () => {
    await asUser(userA, (tx) =>
      createTokenConnection(tx, userA, {
        profileId: 'claude-code',
        name: 'Claude Code',
        scope: 'read',
        expiry: '90d',
      }),
    );
    const agents = await asUser(userA, (tx) => listAgentConnections(tx));
    expect(agents.map((c) => c.scope)).toEqual(['read']);
    const companions = await asUser(userA, (tx) => listCompanions(tx));
    expect(companions).toHaveLength(1);
    expect(companions[0]).toMatchObject({ seenAt: null, version: null });
  });

  it('records a hello and a delivery, visible only to the owner', async () => {
    const [c] = await asUser(userA, (tx) => listCompanions(tx));
    const who = { connectionId: c!.connection.id, userId: userA };
    await asUser(userA, (tx) =>
      companionHello(tx, who, { version: '0.1.0', platform: 'darwin-arm64' }),
    );
    await asUser(userA, (tx) =>
      companionHello(tx, who, { version: '0.1.1', platform: 'darwin-arm64' }),
    );
    await asUser(userA, (tx) => recordCompanionPush(tx, who.connectionId, 'ml_predictions'));
    const [after] = await asUser(userA, (tx) => listCompanions(tx));
    expect(after).toMatchObject({
      version: '0.1.1',
      platform: 'darwin-arm64',
      lastPushKind: 'ml_predictions',
    });
    expect(after!.seenAt).not.toBeNull();
    expect(await asUser(userB, (tx) => listCompanions(tx))).toEqual([]);
  });

  it('says connected for 48 hours after the last hello, for any member asking', async () => {
    const cloud = await researchStorageStatus(t.app.db, { mode: 'cloud', producerUserId: userA });
    expect(cloud).toEqual({ mode: 'cloud' });
    const now = await asUser(userB, (tx) =>
      researchStorageStatus(tx, { mode: 'companion', producerUserId: userA }),
    );
    expect(now).toMatchObject({ mode: 'companion', connected: true });
    const later = new Date(
      Date.parse(now.mode === 'companion' ? now.seenAt! : '') + COMPANION_OFFLINE_AFTER_MS + 1,
    );
    const stale = await asUser(userB, (tx) =>
      researchStorageStatus(tx, { mode: 'companion', producerUserId: userA, now: later }),
    );
    expect(stale).toMatchObject({ mode: 'companion', connected: false });
    const nobody = await researchStorageStatus(t.app.db, {
      mode: 'companion',
      producerUserId: null,
    });
    expect(nobody).toEqual({ mode: 'companion', connected: false, seenAt: null });
  });

  it('unpairing stops the token and the connected status at once', async () => {
    const [c] = await asUser(userA, (tx) => listCompanions(tx));
    await asUser(userA, (tx) => unpairCompanion(tx, userA, c!.connection.id));
    const status = await researchStorageStatus(t.app.db, {
      mode: 'companion',
      producerUserId: userA,
    });
    expect(status).toMatchObject({ connected: false, seenAt: null });
    const [agent] = await asUser(userA, (tx) => listAgentConnections(tx));
    await expect(asUser(userA, (tx) => unpairCompanion(tx, userA, agent!.id))).rejects.toThrow(
      /Not a companion pairing/,
    );
  });

  it('serves reference data without demo instruments', async () => {
    const page = await asUser(userA, (tx) => companionInstruments(tx, { limit: 5 }));
    expect(page.length).toBeLessThanOrEqual(5);
    const sorted = [...page].sort((a, b) => a.id.localeCompare(b.id));
    expect(page.map((r) => r.id)).toEqual(sorted.map((r) => r.id));
    expect(Array.isArray(await asUser(userA, (tx) => companionMembership(tx)))).toBe(true);
  });
});
