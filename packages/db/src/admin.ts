import { randomBytes } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { recordOperatorAudit } from './audit';
import type { Database, Transaction } from './client';
import {
  generateInviteCode,
  hashInviteCode,
  inviteCodeHint,
  openInviteCode,
  sealInviteCode,
} from './invites';
import { platformAdmins, users } from './schema';

/**
 * The admin page's data access (ADR 0037). Every function here takes a
 * transaction opened with withTenant() for the signed-in admin and calls one
 * of the admin_* database functions, which check platform_admin themselves and
 * refuse anyone else with `insufficient_privilege`. Nothing here trusts the
 * caller to have checked.
 */

export class AdminError extends Error {
  constructor(
    readonly code: 'not_admin' | 'refused',
    message: string,
  ) {
    super(message);
  }
}

/** Turns the database's refusals into AdminErrors with a message people can read. */
async function call<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const pg = findPgError(error);
    if (pg?.code === '42501') throw new AdminError('not_admin', 'Only admins can do that.');
    if (pg?.code === '22023') throw new AdminError('refused', capitalize(pg.message));
    throw error;
  }
}

function findPgError(error: unknown): { code: string; message: string } | undefined {
  for (let e: unknown = error, i = 0; e && i < 5; e = (e as { cause?: unknown }).cause, i++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
      return { code, message: String((e as { message?: unknown }).message ?? '') };
    }
  }
  return undefined;
}

const capitalize = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) + '.' : s);

/**
 * A temporary password for an operator or admin reset (ADR 0036): 20
 * characters from a 32-letter alphabet without look-alikes, about 100 bits.
 */
export function generateTemporaryPassword(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789ab';
  return Array.from(randomBytes(20), (b) => alphabet[b % 32]).join('');
}

export async function isPlatformAdmin(tx: Transaction): Promise<boolean> {
  const [row] = await tx.execute<{ ok: boolean }>(sql`select is_platform_admin() as ok`);
  return row?.ok === true;
}

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  createdAt: Date;
  deletedAt: Date | null;
  lockedAt: Date | null;
  isAdmin: boolean;
  planCode: string | null;
  strategies: number;
  runningStrategies: number;
  lastSeenAt: Date | null;
  inviteNote: string | null;
}

const date = (v: unknown): Date | null =>
  v === null || v === undefined ? null : new Date(v as string);
const requiredDate = (v: unknown): Date => new Date(v as string);

export async function adminListUsers(tx: Transaction): Promise<AdminUser[]> {
  const rows = await call(() =>
    tx.execute<Record<string, unknown>>(sql`select * from admin_list_users()`),
  );
  return rows.map((r) => ({
    id: r.id as string,
    email: r.email as string,
    name: r.name as string,
    createdAt: requiredDate(r.created_at),
    deletedAt: date(r.deleted_at),
    lockedAt: date(r.locked_at),
    isAdmin: r.is_admin === true,
    planCode: (r.plan_code as string | null) ?? null,
    strategies: Number(r.strategies ?? 0),
    runningStrategies: Number(r.running_strategies ?? 0),
    lastSeenAt: date(r.last_seen_at),
    inviteNote: (r.invite_note as string | null) ?? null,
  }));
}

/** Locks (ends every session, refuses sign-in) or unlocks someone. Returns whether it changed. */
export async function adminSetUserLocked(
  tx: Transaction,
  userId: string,
  locked: boolean,
): Promise<boolean> {
  const [row] = await call(() =>
    tx.execute<{ changed: boolean }>(
      sql`select admin_set_user_locked(${userId}::uuid, ${locked}) as changed`,
    ),
  );
  return row?.changed === true;
}

/** Stores an already-hashed temporary password and signs the person out everywhere. */
export async function adminResetPassword(
  tx: Transaction,
  userId: string,
  passwordHash: string,
): Promise<boolean> {
  const [row] = await call(() =>
    tx.execute<{ changed: boolean }>(
      sql`select admin_reset_password(${userId}::uuid, ${passwordHash}) as changed`,
    ),
  );
  return row?.changed === true;
}

/**
 * Mints codes and returns them. Stores each code's hash and first group, and,
 * given `sealKey` (the web app's, N238), the whole code encrypted so the admin
 * page can show it again.
 */
export async function adminMintInvites(
  tx: Transaction,
  count: number,
  options: { note?: string; expiresAt?: Date; sealKey?: Buffer } = {},
): Promise<string[]> {
  if (!Number.isInteger(count) || count < 1 || count > 50) {
    throw new AdminError('refused', 'Mint between 1 and 50 codes.');
  }
  const codes = Array.from({ length: count }, generateInviteCode);
  const hashes = sql.join(
    codes.map((c) => sql`${hashInviteCode(c)}`),
    sql`, `,
  );
  const hints = sql.join(
    codes.map((c) => sql`${inviteCodeHint(c)}`),
    sql`, `,
  );
  const key = options.sealKey;
  const sealed = key
    ? sql`array[${sql.join(
        codes.map((c) => sql`${sealInviteCode(c, key)}`),
        sql`, `,
      )}]::text[]`
    : sql`null::text[]`;
  await call(() =>
    tx.execute(
      sql`select admin_mint_invites(array[${hashes}]::char(64)[], array[${hints}]::text[], ${sealed}, ${options.note ?? null}, ${
        options.expiresAt?.toISOString() ?? null
      }::timestamptz)`,
    ),
  );
  return codes;
}

export interface AdminInvite {
  id: string;
  note: string | null;
  createdAt: Date;
  expiresAt: Date | null;
  claimedAt: Date | null;
  claimedBy: string | null;
  claimedByEmail: string | null;
  /** The code's first group of four (`ABCD`), or null for codes minted before N236. */
  codeHint: string | null;
  /** The whole code, when it was kept sealed and `adminListInvites` got the key (N238). */
  code: string | null;
  createdBy: string | null;
  createdByEmail: string | null;
}

export type InviteState = 'open' | 'used' | 'stuck' | 'expired';

/** Open: can be used. Used: someone signed up with it. Stuck: claimed by a sign-up that never finished. */
export function inviteState(invite: AdminInvite, now = new Date()): InviteState {
  if (invite.claimedBy) return 'used';
  if (invite.claimedAt) return 'stuck';
  if (invite.expiresAt && invite.expiresAt <= now) return 'expired';
  return 'open';
}

/** Lists every code; with `sealKey`, whole codes are opened where they were kept (N238). */
export async function adminListInvites(tx: Transaction, sealKey?: Buffer): Promise<AdminInvite[]> {
  const rows = await call(() =>
    tx.execute<Record<string, unknown>>(sql`select * from admin_list_invites()`),
  );
  return rows.map((r) => ({
    id: r.id as string,
    note: (r.note as string | null) ?? null,
    createdAt: requiredDate(r.created_at),
    expiresAt: date(r.expires_at),
    claimedAt: date(r.claimed_at),
    claimedBy: (r.claimed_by as string | null) ?? null,
    claimedByEmail: (r.claimed_by_email as string | null) ?? null,
    codeHint: (r.code_hint as string | null) ?? null,
    code:
      sealKey && typeof r.code_sealed === 'string' ? openInviteCode(r.code_sealed, sealKey) : null,
    createdBy: (r.created_by as string | null) ?? null,
    createdByEmail: (r.created_by_email as string | null) ?? null,
  }));
}

/** 'release' frees a stuck code; 'revoke' expires an open one now. Audited either way. */
export async function adminChangeInvite(
  tx: Transaction,
  inviteId: string,
  change: 'release' | 'revoke',
): Promise<boolean> {
  const [row] = await call(() =>
    tx.execute<{ changed: boolean }>(
      sql`select admin_change_invite(${inviteId}::uuid, ${change}) as changed`,
    ),
  );
  return row?.changed === true;
}

export interface AdminAuditEvent {
  id: string;
  occurredAt: Date;
  actorType: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  userId: string | null;
  userEmail: string | null;
  context: Record<string, unknown>;
}

export async function adminAuditEvents(
  tx: Transaction,
  query: { limit?: number; before?: Date; action?: string; userId?: string } = {},
): Promise<AdminAuditEvent[]> {
  const rows = await call(() =>
    tx.execute<Record<string, unknown>>(
      sql`select * from admin_audit_events(${query.limit ?? 100}::int, ${
        query.before?.toISOString() ?? null
      }::timestamptz, ${query.action ?? null}, ${query.userId ?? null}::uuid)`,
    ),
  );
  return rows.map((r) => ({
    id: r.id as string,
    occurredAt: requiredDate(r.occurred_at),
    actorType: r.actor_type as string,
    action: r.action as string,
    resourceType: r.resource_type as string,
    resourceId: (r.resource_id as string | null) ?? null,
    userId: (r.user_id as string | null) ?? null,
    userEmail: (r.user_email as string | null) ?? null,
    context: (r.context as Record<string, unknown>) ?? {},
  }));
}

/**
 * The users:grant-admin and users:revoke-admin commands. `auth` (tm_auth) finds
 * the account by email; `owner` writes platform_admin and the operator audit
 * event, in one transaction. Returns null when no live account has that email.
 */
export async function setPlatformAdmin(
  owner: Database,
  auth: Database,
  email: string,
  admin: boolean,
): Promise<{ userId: string; changed: boolean } | null> {
  const [user] = await auth
    .select({ id: users.id })
    .from(users)
    .where(
      and(eq(sql`lower(${users.email})`, email.trim().toLowerCase()), isNull(users.deletedAt)),
    );
  if (!user) return null;
  return owner.transaction(async (tx) => {
    const changed = admin
      ? await tx
          .insert(platformAdmins)
          .values({ userId: user.id })
          .onConflictDoNothing()
          .returning({ id: platformAdmins.userId })
      : await tx
          .delete(platformAdmins)
          .where(eq(platformAdmins.userId, user.id))
          .returning({ id: platformAdmins.userId });
    if (changed.length > 0) {
      await recordOperatorAudit(tx, {
        action: admin ? 'admin.granted' : 'admin.revoked',
        resourceType: 'user',
        resourceId: user.id,
      });
    }
    return { userId: user.id, changed: changed.length > 0 };
  });
}
