import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetPasswordAsOperator } from '../src/operator-accounts';
import { accounts, auditEvents, sessions, users } from '../src/schema';
import { withTenant } from '../src/tenant';
import { createTestDatabase, type TestDatabase } from './harness';

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});

afterAll(async () => {
  await t?.drop();
});

async function createAccount(email: string, deleted = false): Promise<string> {
  const [user] = await t.auth.db
    .insert(users)
    .values({ name: 'tester', email, ...(deleted ? { deletedAt: new Date() } : {}) })
    .returning({ id: users.id });
  if (!user) throw new Error('user insert failed');
  await t.auth.db.insert(accounts).values({
    userId: user.id,
    accountId: user.id,
    providerId: 'credential',
    password: 'old-hash',
  });
  await t.auth.db.insert(sessions).values({
    userId: user.id,
    token: `token-${user.id}`,
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  return user.id;
}

describe('operator password reset (ADR 0036)', () => {
  it('replaces the hash, signs the person out and audits it in their trail', async () => {
    const userId = await createAccount('reset-me@example.com');
    const other = await createAccount('leave-me@example.com');

    expect(
      await resetPasswordAsOperator(t.auth.db, t.app.db, '  Reset-Me@Example.com ', 'new-hash'),
    ).toEqual({ userId });

    const [account] = await t.auth.db
      .select({ password: accounts.password })
      .from(accounts)
      .where(and(eq(accounts.userId, userId), eq(accounts.providerId, 'credential')));
    expect(account?.password).toBe('new-hash');
    expect(await t.auth.db.select().from(sessions).where(eq(sessions.userId, userId))).toEqual([]);

    // Nobody else is touched.
    const [untouched] = await t.auth.db
      .select({ password: accounts.password })
      .from(accounts)
      .where(eq(accounts.userId, other));
    expect(untouched?.password).toBe('old-hash');
    expect(await t.auth.db.select().from(sessions).where(eq(sessions.userId, other))).toHaveLength(
      1,
    );

    const trail = await withTenant(t.app.db, { userId }, (tx) =>
      tx
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.action, 'account.password_reset_by_operator')),
    );
    expect(trail).toEqual([
      expect.objectContaining({
        userId,
        actorType: 'system',
        resourceType: 'user',
        resourceId: userId,
      }),
    ]);
    expect(JSON.stringify(trail)).not.toContain('new-hash');
  });

  it('does nothing for an unknown or deleted account', async () => {
    const deleted = await createAccount('gone@example.com', true);
    expect(
      await resetPasswordAsOperator(t.auth.db, t.app.db, 'nobody@example.com', 'h'),
    ).toBeNull();
    expect(await resetPasswordAsOperator(t.auth.db, t.app.db, 'gone@example.com', 'h')).toBeNull();
    const [account] = await t.auth.db
      .select({ password: accounts.password })
      .from(accounts)
      .where(eq(accounts.userId, deleted));
    expect(account?.password).toBe('old-hash');
  });
});
