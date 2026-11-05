import { sql } from 'drizzle-orm';
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
} from '../src/invites';
import { invites, users } from '../src/schema';
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

  it('stores only the hash, so a code cannot be read back', async () => {
    const [code] = await mintInvites(t.owner.db, 1, { note: 'first tester' });
    const rows = await t.owner.db.select().from(invites);
    expect(rows.some((r) => r.codeHash === hashInviteCode(code!))).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(normalizeInviteCode(code!));
    expect(await listInvites(t.owner.db)).toContainEqual(
      expect.objectContaining({ note: 'first tester', claimedAt: null }),
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
