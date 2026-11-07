import {
  createCredential,
  createFeed,
  generateCredentialKeyPair,
  provisionWorkspace,
  schema,
  withTenant,
} from '@tm/db';
import { createTestDatabase, type TestDatabase } from '@tm/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveOptionsAlpacaKey } from '../src/options/app-key';

/**
 * The options recording's Alpaca key (ADR 0050): the worker's own variables
 * win; without them, the oldest platform admin's active Alpaca paper feed.
 * Nobody else's key is ever used.
 */

let t: TestDatabase;
const keys = generateCredentialKeyPair();
const quiet = { warn: () => undefined };

async function userWithAlpacaFeed(email: string, keyId: string) {
  const [user] = await t.auth.db
    .insert(schema.users)
    .values({ name: email, email })
    .returning({ id: schema.users.id });
  const userId = user!.id;
  await provisionWorkspace(t.app.db, { userId, displayName: email });
  await withTenant(t.app.db, { userId }, async (tx) => {
    const credential = await createCredential(tx, {
      userId,
      provider: 'alpaca',
      label: 'Alpaca paper',
      fields: { keyId, secretKey: `secret-for-${keyId}` },
      publicKey: keys.publicKey,
    });
    await createFeed(tx, {
      userId,
      name: 'Alpaca-Paper',
      provider: 'alpaca',
      credentialId: credential.id,
      assetClasses: ['stock', 'etf'],
    });
  });
  return userId;
}

beforeAll(async () => {
  t = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await t?.drop();
});

const resolve = (env: { keyId?: string; secretKey?: string } = {}) =>
  resolveOptionsAlpacaKey({ db: t.worker.db, env, privateKey: keys.privateKey, logger: quiet });

describe('the options Alpaca key', () => {
  it("never borrows a non-admin's feed", async () => {
    await userWithAlpacaFeed('member@example.test', 'PKMEMBER000000000001');
    expect(await resolve()).toBeUndefined();
  });

  it("falls back to the platform admin's Alpaca feed", async () => {
    const admin = await userWithAlpacaFeed('admin@example.test', 'PKADMIN0000000000001');
    await t.ownerSql`insert into platform_admin (user_id) values (${admin})`;
    expect(await resolve()).toEqual({
      keyId: 'PKADMIN0000000000001',
      secretKey: 'secret-for-PKADMIN0000000000001',
      source: 'admin_feed',
    });
  });

  it("uses the worker's own key when it has one", async () => {
    expect(await resolve({ keyId: 'PKENV', secretKey: 'env-secret' })).toEqual({
      keyId: 'PKENV',
      secretKey: 'env-secret',
      source: 'env',
    });
  });

  it("keeps the admin list from the app's login", async () => {
    await expect(t.app.db.execute('select * from options_key_admins()')).rejects.toThrow();
  });
});
