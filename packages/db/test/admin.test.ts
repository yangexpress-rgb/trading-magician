import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AdminError,
  adminAuditEvents,
  adminChangeInvite,
  adminListInvites,
  adminListUsers,
  adminMintInvites,
  adminResetPassword,
  adminSetUserLocked,
  inviteState,
  isPlatformAdmin,
  setPlatformAdmin,
} from '../src/admin';
import {
  attachInvite,
  claimInvite,
  hashInviteCode,
  inviteCodeKey,
  normalizeInviteCode,
} from '../src/invites';
import { accounts, auditEvents, sessions, users } from '../src/schema';
import { withTenant } from '../src/tenant';
import { createTestDatabase, type TestDatabase } from './harness';

let t: TestDatabase;
let admin: string;
let tester: string;

beforeAll(async () => {
  t = await createTestDatabase();
  admin = await createAccount('Boss@example.com');
  tester = await createAccount('tester@example.com');
  expect(await setPlatformAdmin(t.owner.db, t.auth.db, ' boss@EXAMPLE.com ', true)).toEqual({
    userId: admin,
    changed: true,
  });
});

afterAll(async () => {
  await t?.drop();
});

async function createAccount(email: string): Promise<string> {
  const [user] = await t.auth.db
    .insert(users)
    .values({ name: 'someone', email })
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

const asAdmin = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(t.app.db, { userId: admin }, fn);
const asTester = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(t.app.db, { userId: tester }, fn);

describe('admin access (ADR 0037)', () => {
  it('knows who is an admin', async () => {
    expect(await asAdmin(isPlatformAdmin)).toBe(true);
    expect(await asTester(isPlatformAdmin)).toBe(false);
    expect(await t.app.db.transaction(isPlatformAdmin)).toBe(false);
  });

  it('refuses every admin action to someone who is not an admin', async () => {
    const attempts: ((tx: Parameters<typeof isPlatformAdmin>[0]) => Promise<unknown>)[] = [
      adminListUsers,
      adminListInvites,
      (tx) => adminAuditEvents(tx),
      (tx) => adminMintInvites(tx, 1),
      (tx) => adminSetUserLocked(tx, admin, true),
      (tx) => adminResetPassword(tx, admin, 'evil'),
      (tx) => adminChangeInvite(tx, admin, 'revoke'),
    ];
    for (const attempt of attempts) {
      await expect(asTester(attempt)).rejects.toMatchObject({ code: 'not_admin' });
    }
  });

  it('keeps platform_admin out of reach of the app roles', async () => {
    await expect(t.appSql`select * from platform_admin`).rejects.toThrow(/permission denied/);
    await expect(t.appSql`insert into platform_admin (user_id) values (${tester})`).rejects.toThrow(
      /permission denied/,
    );
  });

  it('lists everyone with their plan, strategies and last visit', async () => {
    const list = await asAdmin(adminListUsers);
    const emails = list.map((u) => u.email);
    expect(emails).toEqual(expect.arrayContaining(['Boss@example.com', 'tester@example.com']));
    const me = list.find((u) => u.id === admin);
    expect(me).toMatchObject({ isAdmin: true, lockedAt: null, strategies: 0 });
    expect(me?.lastSeenAt).toBeInstanceOf(Date);
    expect(list.find((u) => u.id === tester)?.isAdmin).toBe(false);
  });

  it('locks someone out, ends their sessions and audits it twice', async () => {
    expect(await asAdmin((tx) => adminSetUserLocked(tx, tester, true))).toBe(true);
    // Locking again changes nothing.
    expect(await asAdmin((tx) => adminSetUserLocked(tx, tester, true))).toBe(false);

    const [row] = await t.auth.db
      .select({ lockedAt: users.lockedAt })
      .from(users)
      .where(eq(users.id, tester));
    expect(row?.lockedAt).toBeInstanceOf(Date);
    expect(await t.auth.db.select().from(sessions).where(eq(sessions.userId, tester))).toEqual([]);
    // The admin's own session is untouched.
    expect(await t.auth.db.select().from(sessions).where(eq(sessions.userId, admin))).toHaveLength(
      1,
    );

    const own = await asTester((tx) => tx.select({ action: auditEvents.action }).from(auditEvents));
    expect(own.map((e) => e.action)).toContain('account.locked_by_admin');
    const trail = await asAdmin((tx) => adminAuditEvents(tx, { action: 'admin.' }));
    expect(trail[0]).toMatchObject({
      action: 'admin.user_locked',
      resourceId: tester,
      userId: null,
      context: { adminId: admin },
    });

    expect(await asAdmin((tx) => adminSetUserLocked(tx, tester, false))).toBe(true);
    const [after] = await t.auth.db
      .select({ lockedAt: users.lockedAt })
      .from(users)
      .where(eq(users.id, tester));
    expect(after?.lockedAt).toBeNull();
  });

  it('will not lock the admin themselves or another admin', async () => {
    await expect(asAdmin((tx) => adminSetUserLocked(tx, admin, true))).rejects.toBeInstanceOf(
      AdminError,
    );
    const other = await createAccount('second-admin@example.com');
    await setPlatformAdmin(t.owner.db, t.auth.db, 'second-admin@example.com', true);
    await expect(asAdmin((tx) => adminSetUserLocked(tx, other, true))).rejects.toMatchObject({
      code: 'refused',
      message: 'Admins cannot be locked.',
    });
    expect(
      await setPlatformAdmin(t.owner.db, t.auth.db, 'second-admin@example.com', false),
    ).toEqual({ userId: other, changed: true });
  });

  it('resets a password and signs the person out', async () => {
    await t.auth.db.insert(sessions).values({
      userId: tester,
      token: `again-${tester}`,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    expect(await asAdmin((tx) => adminResetPassword(tx, tester, 'new-hash'))).toBe(true);
    const [account] = await t.auth.db
      .select({ password: accounts.password })
      .from(accounts)
      .where(eq(accounts.userId, tester));
    expect(account?.password).toBe('new-hash');
    expect(await t.auth.db.select().from(sessions).where(eq(sessions.userId, tester))).toEqual([]);
    const trail = await asAdmin((tx) => adminAuditEvents(tx, { userId: tester }));
    expect(trail.map((e) => e.action)).toContain('account.password_reset_by_operator');
    // Never a hash in the trail.
    const all = await t.ownerSql`select context::text as c from audit_event`;
    expect(all.some((r) => String(r.c).includes('new-hash'))).toBe(false);
  });

  it('mints, lists, revokes and releases invite codes without auditing any code', async () => {
    const key = inviteCodeKey('x'.repeat(32));
    const codes = await asAdmin((tx) => adminMintInvites(tx, 2, { note: 'friends', sealKey: key }));
    expect(codes).toHaveLength(2);
    // With the key, the list opens each whole code (N238); without it, it can't.
    const opened = (await asAdmin((tx) => adminListInvites(tx, key))).filter(
      (i) => i.note === 'friends',
    );
    expect(opened.map((i) => i.code).sort()).toEqual([...codes].sort());
    const wrongKey = await asAdmin((tx) => adminListInvites(tx, inviteCodeKey('y'.repeat(32))));
    expect(wrongKey.every((i) => i.code === null)).toBe(true);
    const sealedRows = await t.ownerSql`select code_sealed from invite`;
    expect(JSON.stringify(sealedRows)).not.toContain(normalizeInviteCode(codes[0]!));
    let invites = await asAdmin(adminListInvites);
    const mine = invites.filter((i) => i.note === 'friends');
    expect(mine.map((i) => inviteState(i))).toEqual(['open', 'open']);
    // Each row shows its code's first group and who minted it, never the rest (N236).
    expect(mine.map((i) => i.codeHint).sort()).toEqual(codes.map((c) => c.slice(0, 4)).sort());
    expect(mine.every((i) => i.createdBy === admin && i.createdByEmail !== null)).toBe(true);

    // One gets used, the other is revoked.
    const [first, second] = codes as [string, string];
    expect(await claimInvite(t.app.db, first)).not.toBeNull();
    const stuck = (await asAdmin(adminListInvites)).find(
      (i) => i.note === 'friends' && i.claimedAt,
    );
    expect(stuck && inviteState(stuck)).toBe('stuck');
    expect(await asAdmin((tx) => adminChangeInvite(tx, stuck!.id, 'release'))).toBe(true);
    expect(await claimInvite(t.app.db, first)).not.toBeNull();
    await attachInvite(t.app.db, first, tester);

    invites = await asAdmin(adminListInvites);
    const used = invites.find((i) => i.claimedBy === tester);
    expect(used && inviteState(used)).toBe('used');
    expect(used?.claimedByEmail).toBe('tester@example.com');
    // A used code can be neither released nor revoked.
    expect(await asAdmin((tx) => adminChangeInvite(tx, used!.id, 'release'))).toBe(false);
    expect(await asAdmin((tx) => adminChangeInvite(tx, used!.id, 'revoke'))).toBe(false);

    const open = invites.find((i) => i.note === 'friends' && !i.claimedAt)!;
    expect(await asAdmin((tx) => adminChangeInvite(tx, open.id, 'revoke'))).toBe(true);
    expect(await claimInvite(t.app.db, second)).toBeNull();

    const text = (await t.ownerSql`select context::text as c from audit_event`)
      .map((r) => String(r.c))
      .join('\n');
    for (const code of codes) {
      expect(text).not.toContain(code);
      expect(text).not.toContain(code.replace(/-/g, ''));
      expect(text).not.toContain(hashInviteCode(code));
    }
    const actions = (await asAdmin((tx) => adminAuditEvents(tx, { action: 'invite.' }))).map(
      (e) => e.action,
    );
    expect(actions).toEqual(
      expect.arrayContaining(['invite.minted', 'invite.released', 'invite.revoked']),
    );
  });

  it('pages through the whole audit trail', async () => {
    const page = await asAdmin((tx) => adminAuditEvents(tx, { limit: 2 }));
    expect(page).toHaveLength(2);
    const next = await asAdmin((tx) =>
      adminAuditEvents(tx, { limit: 2, before: page[1]!.occurredAt }),
    );
    expect(next.every((e) => e.occurredAt <= page[1]!.occurredAt)).toBe(true);
    // Admin grants are audited as operator events too.
    const grants = await asAdmin((tx) => adminAuditEvents(tx, { action: 'admin.granted' }));
    expect(grants.map((e) => e.resourceId)).toContain(admin);
  });

  it('refuses minting more than 50 at once', async () => {
    await expect(asAdmin((tx) => adminMintInvites(tx, 51))).rejects.toMatchObject({
      code: 'refused',
    });
    // The database refuses too, whoever calls it.
    await expect(
      asAdmin((tx) => tx.execute(sql`select admin_mint_invites(array[]::char(64)[], null, null)`)),
    ).rejects.toThrow();
  });
});
