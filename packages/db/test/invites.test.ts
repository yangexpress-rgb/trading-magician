import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  attachInvite,
  claimInvite,
  countClaimedInvites,
  generateInviteCode,
  hashInviteCode,
  inviteCodeMatches,
  listInvites,
  mintInvites,
  normalizeInviteCode,
  releaseInvite,
  releaseInviteAsOperator,
} from '../src/invites';
import { auditEvents, invites, users } from '../src/schema';
import { withTenant } from '../src/tenant';
import { createTestDatabase, type TestDatabase } from './harness';

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});

afterAll(async () => {
  await t?.drop();
});

async function createUser(email: string): Promise<string> {
  const [row] = await t.auth.db
    .insert(users)
    .values({ name: 'invited', email })
    .returning({ id: users.id });
  if (!row) throw new Error('user insert failed');
  return row.id;
}

describe('invite codes', () => {
  it('reads the same however it is typed, and never matches another code', () => {
    const code = generateInviteCode();
    expect(code).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
    expect(normalizeInviteCode(code.toLowerCase().replace(/-/g, ' '))).toBe(code.replace(/-/g, ''));
    expect(inviteCodeMatches(code.toLowerCase(), hashInviteCode(code))).toBe(true);
    expect(inviteCodeMatches(generateInviteCode(), hashInviteCode(code))).toBe(false);
  });

  it('stores only the hash and first group, so a code cannot be read back', async () => {
    const [code] = await mintInvites(t.owner.db, 1, { note: 'first tester' });
    const rows = await t.owner.db.select().from(invites);
    expect(rows.some((r) => r.codeHash === hashInviteCode(code!))).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(normalizeInviteCode(code!));
    expect(JSON.stringify(rows)).not.toContain(normalizeInviteCode(code!).slice(4));
    expect(await listInvites(t.owner.db)).toContainEqual(
      expect.objectContaining({
        note: 'first tester',
        claimedAt: null,
        codeHint: code!.slice(0, 4),
      }),
    );
  });

  it('admits one person per code and names who used it', async () => {
    const [code] = await mintInvites(t.owner.db, 1);
    const claimed = await claimInvite(t.app.db, code!);
    expect(claimed).not.toBeNull();
    expect(await claimInvite(t.app.db, code!)).toBeNull();
    const userId = await createUser('invited-a@example.test');
    await attachInvite(t.auth.db, code!, userId);
    const [row] = await t.owner.db
      .select()
      .from(invites)
      .where(sql`code_hash = ${hashInviteCode(code!)}`);
    expect(row?.claimedBy).toBe(userId);
    expect(row?.claimedAt).toBeInstanceOf(Date);
    // A later attach cannot move a used code to someone else.
    await attachInvite(t.auth.db, code!, await createUser('invited-b@example.test'));
    const [again] = await t.owner.db
      .select()
      .from(invites)
      .where(sql`code_hash = ${hashInviteCode(code!)}`);
    expect(again?.claimedBy).toBe(userId);
  });

  it('refuses an unknown or expired code, and gives an unused one back', async () => {
    expect(await claimInvite(t.app.db, 'ZZZZ-ZZZZ-ZZZZ-ZZZZ')).toBeNull();
    const [expired] = await mintInvites(t.owner.db, 1, {
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(await claimInvite(t.app.db, expired!)).toBeNull();

    const [code] = await mintInvites(t.owner.db, 1);
    expect(await claimInvite(t.app.db, code!)).not.toBeNull();
    await releaseInvite(t.app.db, code!);
    expect(await claimInvite(t.app.db, code!)).not.toBeNull();
  });

  it('keeps the table itself away from the app and the auth role', async () => {
    await expect(t.appSql.unsafe('select * from invite')).rejects.toMatchObject({ code: '42501' });
    await expect(t.appSql.unsafe('update invite set claimed_at = null')).rejects.toMatchObject({
      code: '42501',
    });
    await expect(t.auth.db.select().from(invites)).rejects.toMatchObject({
      cause: { code: '42501' },
    });
  });

  it('counts how many invites have been used, for the launch cap', async () => {
    const before = await countClaimedInvites(t.owner.db);
    const [code] = await mintInvites(t.owner.db, 1);
    await claimInvite(t.app.db, code!);
    expect(await countClaimedInvites(t.owner.db)).toBe(before + 1);
  });
});

describe('invite administration audit (deviation D6)', () => {
  async function operatorEvents(action: string) {
    return t.owner.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, action), isNull(auditEvents.userId)));
  }

  /** Every audit row as text, the way someone grepping the trail would see it. */
  async function wholeAuditTrail(): Promise<string> {
    const rows = await t.ownerSql.unsafe<{ row: string }[]>(
      'select audit_event::text as row from audit_event',
    );
    return rows.map((r) => r.row).join('\n');
  }

  it('writes one system event per minted batch, with the count and note', async () => {
    const before = (await operatorEvents('invite.minted')).length;
    const codes = await mintInvites(t.owner.db, 3, { note: 'D6 batch' });
    expect(codes).toHaveLength(3);
    const events = await operatorEvents('invite.minted');
    expect(events).toHaveLength(before + 1);
    expect(events.at(-1)).toMatchObject({
      userId: null,
      actorType: 'system',
      resourceType: 'invite',
      resourceId: null,
      context: { count: 3, note: 'D6 batch', expiresAt: null },
    });
  });

  it('writes a system event for each release, with the count freed and the note', async () => {
    const [code] = await mintInvites(t.owner.db, 1);
    const claimedId = await claimInvite(t.app.db, code!);
    expect(claimedId).not.toBeNull();

    expect(await releaseInviteAsOperator(t.owner.db, code!, { note: 'email bounced' })).toEqual({
      released: true,
    });
    // Freed, so it admits someone again.
    expect(await claimInvite(t.app.db, code!)).not.toBeNull();

    // A code already used by an account is not freed, but the attempt is still on record.
    await attachInvite(t.auth.db, code!, await createUser('invited-d6@example.test'));
    expect(await releaseInviteAsOperator(t.owner.db, code!)).toEqual({ released: false });

    const events = (await operatorEvents('invite.released')).slice(-2);
    expect(events).toMatchObject([
      {
        userId: null,
        actorType: 'system',
        resourceType: 'invite',
        resourceId: claimedId,
        context: { count: 1, note: 'email bounced' },
      },
      { userId: null, actorType: 'system', resourceId: null, context: { count: 0, note: null } },
    ]);
  });

  it('never puts a code, in any spelling, or its hash into the audit trail', async () => {
    const minted = await mintInvites(t.owner.db, 5, { note: 'no codes in audit' });
    await claimInvite(t.app.db, minted[0]!);
    await releaseInviteAsOperator(t.owner.db, minted[0]!, { note: 'no codes in audit' });
    await releaseInviteAsOperator(t.owner.db, 'ZZZZ-ZZZZ-ZZZZ-ZZZZ');

    const trail = (await wholeAuditTrail()).toUpperCase();
    expect(trail).toContain('INVITE.MINTED');
    expect(trail).toContain('INVITE.RELEASED');
    for (const code of [...minted, 'ZZZZ-ZZZZ-ZZZZ-ZZZZ']) {
      expect(trail).not.toContain(code);
      expect(trail).not.toContain(normalizeInviteCode(code));
      expect(trail).not.toContain(hashInviteCode(code).toUpperCase());
    }
  });

  it('keeps operator events out of every workspace, and out of reach of the app', async () => {
    await mintInvites(t.owner.db, 1, { note: 'hidden from tenants' });
    const userId = await createUser('tenant-d6@example.test');
    const visible = await withTenant(t.app.db, { userId }, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.resourceType, 'invite')),
    );
    expect(visible).toEqual([]);
    await expect(
      withTenant(t.app.db, { userId }, (tx) =>
        tx.insert(auditEvents).values({
          userId: null,
          actorType: 'system',
          action: 'invite.minted',
          resourceType: 'invite',
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('allows a missing user only on system events', async () => {
    await expect(
      t.owner.db.insert(auditEvents).values({
        userId: null,
        actorType: 'user',
        action: 'invite.minted',
        resourceType: 'invite',
      }),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('leaves the sign-up gate rolling back its own claim unaudited', async () => {
    const [code] = await mintInvites(t.owner.db, 1);
    await claimInvite(t.app.db, code!);
    const before = (await operatorEvents('invite.released')).length;
    await releaseInvite(t.app.db, code!);
    expect(await operatorEvents('invite.released')).toHaveLength(before);
  });
});
