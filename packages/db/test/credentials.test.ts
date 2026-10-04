import { inspect } from 'node:util';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Transaction } from '../src/client';
import {
  createCredential,
  CredentialError,
  deleteCredential,
  listCredentials,
  openCredential,
  rotateCredential,
} from '../src/credentials';
import { provisionWorkspace } from '../src/provision';
import { auditEvents, credentials, dataFeedConnections, users } from '../src/schema';
import { generateCredentialKeyPair, openSecret, sealSecret } from '../src/sealed';
import { withTenant } from '../src/tenant';
import { createTestDatabase, type TestDatabase } from './harness';

const KEY_ID = 'PKTESTKEYID00007Q2A';
const SECRET = 'very-secret-value-0123456789abcdefXYZ9';

let t: TestDatabase;
let userA: string;
let userB: string;
const keys = generateCredentialKeyPair();
const otherKeys = generateCredentialKeyPair();

function pgCode(error: unknown): string | undefined {
  const e = error as { code?: string; cause?: { code?: string } };
  return e.code ?? e.cause?.code;
}

async function createUser(email: string): Promise<string> {
  const [row] = await t.auth.db
    .insert(users)
    .values({ name: email.split('@')[0] ?? email, email })
    .returning({ id: users.id });
  if (!row) throw new Error('user insert failed');
  return row.id;
}

const as = <T>(userId: string, fn: (tx: Transaction) => Promise<T>) =>
  withTenant(t.app.db, { userId }, fn);
const asWorker = <T>(userId: string, fn: (tx: Transaction) => Promise<T>) =>
  withTenant(t.worker.db, { userId }, fn);

const save = (userId: string) =>
  as(userId, (tx) =>
    createCredential(tx, {
      userId,
      provider: 'alpaca',
      label: 'My Alpaca paper key',
      fields: { keyId: KEY_ID, secretKey: SECRET },
      publicKey: keys.publicKey,
    }),
  );

beforeAll(async () => {
  t = await createTestDatabase();
  userA = await createUser('cred-a@example.test');
  userB = await createUser('cred-b@example.test');
  for (const userId of [userA, userB]) {
    await provisionWorkspace(t.app.db, { userId, displayName: 'Test' });
  }
}, 60_000);

afterAll(async () => {
  await t?.drop();
});

describe('sealing', () => {
  it('opens only with the matching private key and the same row binding', () => {
    const sealed = sealSecret(keys.publicKey, 'hello', 'row-1');
    expect(openSecret(keys.privateKey, sealed, 'row-1')).toBe('hello');
    expect(() => openSecret(keys.privateKey, sealed, 'row-2')).toThrow(/could not be opened/);
    expect(() => openSecret(otherKeys.privateKey, sealed, 'row-1')).toThrow(/different key/);
    expect(sealed.ciphertext.toString('utf8')).not.toContain('hello');
  });

  it('refuses weak or non-RSA keys', () => {
    expect(() => sealSecret('not a key', 'x', 'y')).toThrow(/not a valid PEM/);
  });
});

describe('stored credentials', () => {
  it('returns only masked tails, and stores no plaintext anywhere', async () => {
    const saved = await save(userA);
    expect(saved).toMatchObject({
      provider: 'alpaca',
      label: 'My Alpaca paper key',
      environment: 'paper',
      hint: { keyId: '••••7Q2A', secretKey: '••••XYZ9' },
      usedBy: [],
    });
    expect(JSON.stringify(saved)).not.toContain(SECRET);
    expect(JSON.stringify(saved)).not.toContain(KEY_ID);

    // Nothing readable in the table, and nothing in the audit trail.
    const [raw] = await t.ownerSql<{ row: string }[]>`
      select row_to_json(c)::text as row from credential c where id = ${saved.id}`;
    expect(raw?.row).not.toContain(SECRET);
    expect(raw?.row).not.toContain(KEY_ID);
    const audit = await t.owner.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.resourceId, saved.id));
    expect(audit.map((a) => a.action)).toEqual(['credential.created']);
    expect(JSON.stringify(audit)).not.toContain(SECRET);
  });

  it('never lets the web login read the sealed columns', async () => {
    const saved = await save(userA);
    for (const column of ['ciphertext', 'wrapped_key', 'iv', 'auth_tag']) {
      const error = await as(userA, (tx) =>
        tx.execute(sql.raw(`select ${column} from credential where id = '${saved.id}'`)),
      ).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(pgCode(error), column).toBe('42501');
    }
    // And the web login cannot open one even when asked to.
    const error = await as(userA, (tx) =>
      openCredential(tx, { userId: userA, id: saved.id, privateKey: keys.privateKey }),
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(pgCode(error)).toBe('42501');
  });

  it('lets the worker open its own tenant’s credential, hidden from logs', async () => {
    const saved = await save(userA);
    const opened = await asWorker(userA, (tx) =>
      openCredential(tx, { userId: userA, id: saved.id, privateKey: keys.privateKey }),
    );
    expect(opened.fields).toEqual({ keyId: KEY_ID, secretKey: SECRET });
    expect(JSON.stringify(opened)).not.toContain(SECRET);
    expect(inspect(opened)).not.toContain(SECRET);

    // Another tenant's worker transaction sees nothing.
    await expect(
      asWorker(userB, (tx) =>
        openCredential(tx, { userId: userA, id: saved.id, privateKey: keys.privateKey }),
      ),
    ).rejects.toThrow(CredentialError);
  });

  it('rotates the value in place and keeps it bound to its row', async () => {
    const saved = await save(userA);
    const rotated = await as(userA, (tx) =>
      rotateCredential(tx, {
        userId: userA,
        id: saved.id,
        fields: { keyId: 'PKNEWKEYID000000AB12', secretKey: 'another-secret-value-000000QQQ1' },
        publicKey: keys.publicKey,
      }),
    );
    expect(rotated.hint).toEqual({ keyId: '••••AB12', secretKey: '••••QQQ1' });
    expect(rotated.rotatedAt).not.toBeNull();
    const opened = await asWorker(userA, (tx) =>
      openCredential(tx, { userId: userA, id: saved.id, privateKey: keys.privateKey }),
    );
    expect(opened.fields.secretKey).toBe('another-secret-value-000000QQQ1');

    // Ciphertext moved onto another row no longer opens.
    const other = await save(userA);
    await t.ownerSql`
      update credential set (key_id, wrapped_key, iv, ciphertext, auth_tag) =
        (select key_id, wrapped_key, iv, ciphertext, auth_tag from credential where id = ${saved.id})
      where id = ${other.id}`;
    await expect(
      asWorker(userA, (tx) =>
        openCredential(tx, { userId: userA, id: other.id, privateKey: keys.privateKey }),
      ),
    ).rejects.toThrow(/could not be opened/);
  });

  it('checks the fields the provider needs, and refuses without a configured key', async () => {
    await expect(
      as(userA, (tx) =>
        createCredential(tx, {
          userId: userA,
          provider: 'alpaca',
          label: 'Half',
          fields: { keyId: KEY_ID },
          publicKey: keys.publicKey,
        }),
      ),
    ).rejects.toThrow(/Enter API key ID and Secret key/);
    await expect(
      as(userA, (tx) =>
        createCredential(tx, {
          userId: userA,
          provider: 'demo',
          label: 'Demo',
          fields: {},
          publicKey: keys.publicKey,
        }),
      ),
    ).rejects.toThrow(/does not take a credential/);
    await expect(
      as(userA, (tx) =>
        createCredential(tx, {
          userId: userA,
          provider: 'alpaca',
          label: 'No key',
          fields: { keyId: KEY_ID, secretKey: SECRET },
          publicKey: undefined,
        }),
      ),
    ).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('refuses to delete a credential a connection uses, and hides other tenants', async () => {
    const saved = await save(userA);
    await as(userA, (tx) =>
      tx.insert(dataFeedConnections).values({
        userId: userA,
        name: 'Alpaca prices',
        provider: 'alpaca',
        credentialRef: saved.id,
        assetClasses: ['stock'],
      }),
    );
    await expect(
      as(userA, (tx) => deleteCredential(tx, { userId: userA, id: saved.id })),
    ).rejects.toMatchObject({ code: 'conflict' });
    const listed = await as(userA, (tx) => listCredentials(tx));
    expect(listed.find((c) => c.id === saved.id)?.usedBy).toEqual([
      expect.objectContaining({ kind: 'data_feed', name: 'Alpaca prices' }),
    ]);
    expect(await as(userB, (tx) => listCredentials(tx))).toEqual([]);

    await as(userA, (tx) =>
      tx.delete(dataFeedConnections).where(eq(dataFeedConnections.credentialRef, saved.id)),
    );
    await as(userA, (tx) => deleteCredential(tx, { userId: userA, id: saved.id }));
    const left = await t.owner.db.select().from(credentials).where(eq(credentials.id, saved.id));
    expect(left).toEqual([]);
  });

  it('cannot hold a live credential', async () => {
    const saved = await save(userA);
    const error = await t.owner.db
      .update(credentials)
      .set({ environment: 'live' })
      .where(eq(credentials.id, saved.id))
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(pgCode(error)).toBe('23514');
  });
});
