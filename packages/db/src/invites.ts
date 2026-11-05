import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { sql, desc, isNotNull } from 'drizzle-orm';
import type { Database, Transaction } from './client';
import { invites } from './schema';

type Db = Database | Transaction;

/** Codes people can read out loud: 4 groups of 4 from an alphabet without look-alikes. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateInviteCode(): string {
  const bytes = randomBytes(16);
  const letters = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
  return letters.replace(/(.{4})(?=.)/g, '$1-');
}

/** Upper-cases and strips spaces and dashes, so people can type it as they like. */
export function normalizeInviteCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function hashInviteCode(code: string): string {
  return createHash('sha256').update(normalizeInviteCode(code)).digest('hex');
}

/** Constant-time compare, for callers checking a code against a known hash. */
export function inviteCodeMatches(code: string, hash: string): boolean {
  const a = Buffer.from(hashInviteCode(code), 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Mints `count` codes and returns them; only the hashes are stored. */
export async function mintInvites(
  db: Db,
  count: number,
  options: { note?: string; expiresAt?: Date } = {},
): Promise<string[]> {
  const codes = Array.from({ length: count }, generateInviteCode);
  await db.insert(invites).values(
    codes.map((code) => ({
      codeHash: hashInviteCode(code),
      ...(options.note ? { note: options.note } : {}),
      ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
    })),
  );
  return codes;
}

/**
 * Claims a code, returning its id, or null when it is unknown, used or expired.
 * One code admits one person even under concurrent sign-ups.
 */
export async function claimInvite(db: Db, code: string): Promise<string | null> {
  const rows = await db.execute<{ id: string | null }>(
    sql`select claim_invite(${hashInviteCode(code)}::char(64)) as id`,
  );
  return rows[0]?.id ?? null;
}

/** Records who used a claimed code, once their account exists. */
export async function attachInvite(db: Db, code: string, userId: string): Promise<void> {
  await db.execute(sql`select attach_invite(${hashInviteCode(code)}::char(64), ${userId}::uuid)`);
}

/** Gives a claimed code back when the sign-up it was claimed for did not finish. */
export async function releaseInvite(db: Db, code: string): Promise<void> {
  await db.execute(sql`select release_invite(${hashInviteCode(code)}::char(64))`);
}

export interface InviteSummary {
  note: string | null;
  createdAt: Date;
  expiresAt: Date | null;
  claimedAt: Date | null;
}

/** Owner-only view of how the launch is going; never shows a code. */
export async function listInvites(db: Db): Promise<InviteSummary[]> {
  return db
    .select({
      note: invites.note,
      createdAt: invites.createdAt,
      expiresAt: invites.expiresAt,
      claimedAt: invites.claimedAt,
    })
    .from(invites)
    .orderBy(desc(invites.createdAt));
}

export async function countClaimedInvites(db: Db): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(invites)
    .where(isNotNull(invites.claimedAt));
  return rows[0]?.n ?? 0;
}
