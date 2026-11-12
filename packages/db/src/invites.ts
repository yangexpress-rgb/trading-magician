import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { recordOperatorAudit } from './audit';
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

/**
 * The code's first group of four, stored so the owner can tell codes apart
 * (N236, ADR 0083). Shown as `ABCD-…`; the rest of the code stays hash-only.
 */
export function inviteCodeHint(code: string): string {
  return normalizeInviteCode(code).slice(0, 4);
}

/**
 * The key that seals whole codes for the admin page (N238, ADR 0085), derived
 * from a secret only the web app holds (its BETTER_AUTH_SECRET).
 */
export function inviteCodeKey(secret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, 'tm-invite-code', 'invite code v1', 32));
}

/** AES-256-GCM: `v1.` + base64url(iv | tag | ciphertext). */
export function sealInviteCode(code: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(code, 'utf8'), cipher.final()]);
  return `v1.${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')}`;
}

/** The code, or null when it was sealed with another key or is damaged. */
export function openInviteCode(sealed: string, key: Buffer): string | null {
  if (!sealed.startsWith('v1.')) return null;
  try {
    const raw = Buffer.from(sealed.slice(3), 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
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

/**
 * Mints `count` codes and returns them; only the hashes and first groups are stored. Each batch
 * writes one `invite.minted` operator audit event with the count, the note and
 * the expiry, never a code (deviation D6). Needs the owner connection.
 */
export async function mintInvites(
  db: Db,
  count: number,
  options: { note?: string; expiresAt?: Date } = {},
): Promise<string[]> {
  const codes = Array.from({ length: count }, generateInviteCode);
  await db.transaction(async (tx) => {
    await tx.insert(invites).values(
      codes.map((code) => ({
        codeHash: hashInviteCode(code),
        codeHint: inviteCodeHint(code),
        ...(options.note ? { note: options.note } : {}),
        ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
      })),
    );
    await recordOperatorAudit(tx, {
      action: 'invite.minted',
      resourceType: 'invite',
      context: {
        count,
        note: options.note ?? null,
        expiresAt: options.expiresAt?.toISOString() ?? null,
      },
    });
  });
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

/**
 * Gives a claimed code back when the sign-up it was claimed for did not finish.
 * This is the sign-up gate rolling back its own claim; an operator freeing a
 * code uses `releaseInviteAsOperator`, which is audited.
 */
export async function releaseInvite(db: Db, code: string): Promise<void> {
  await db.execute(sql`select release_invite(${hashInviteCode(code)}::char(64))`);
}

/**
 * The `invites:release` command: frees a claimed code nobody finished signing
 * up with, and writes an `invite.released` operator audit event either way,
 * with how many codes were freed (0 or 1) and the operator's note. The event
 * names the invite by its id, never by its code. Needs the owner connection.
 */
export async function releaseInviteAsOperator(
  db: Db,
  code: string,
  options: { note?: string } = {},
): Promise<{ released: boolean }> {
  const codeHash = hashInviteCode(code);
  return db.transaction(async (tx) => {
    const freed = await tx
      .update(invites)
      .set({ claimedAt: null })
      .where(
        and(
          eq(invites.codeHash, codeHash),
          isNotNull(invites.claimedAt),
          isNull(invites.claimedBy),
        ),
      )
      .returning({ id: invites.id });
    const id = freed[0]?.id;
    await recordOperatorAudit(tx, {
      action: 'invite.released',
      resourceType: 'invite',
      ...(id ? { resourceId: id } : {}),
      context: { count: freed.length, note: options.note ?? null },
    });
    return { released: freed.length > 0 };
  });
}

export interface InviteSummary {
  /** First group of four, or null for codes minted before N236. */
  codeHint: string | null;
  note: string | null;
  createdAt: Date;
  expiresAt: Date | null;
  claimedAt: Date | null;
}

/** Owner-only view of how the launch is going; never shows a whole code. */
export async function listInvites(db: Db): Promise<InviteSummary[]> {
  return db
    .select({
      codeHint: invites.codeHint,
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
