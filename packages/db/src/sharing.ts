import {
  isFixtureName,
  parseDefinition,
  registerLibraryEntrySchema,
  type RegisterLibraryEntryInput,
} from '@tm/domain';
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database, Transaction } from './client';
import { preferredLegAccountId } from './leg-accounts';
import { registerLibraryEntry } from './library';
import { sharePersonLabel } from './share-provenance';
import {
  strategies,
  strategyLibraryEntries as entries,
  strategyLibraryRevisions as revisions,
  strategyShares,
  users,
  SHARE_STATUSES,
} from './schema';
import { createStrategy, StrategyError } from './strategies';

/**
 * Strategy sharing (ADR 0056). A member sends a snapshot of a Library record,
 * or of one of their Strategy Lab strategies with its record, to another
 * member, who accepts (an independent copy with a new number) or declines.
 * Every cross-member step is a share_* database function (migration 0071):
 * this module builds snapshots from what the sender can read and makes the
 * copies as the recipient, inside the recipient's own transaction.
 */

export { SHARE_STATUSES };
export type ShareKind = 'library' | 'lab';
export type ShareStatus = (typeof SHARE_STATUSES)[number];

export type ShareErrorCode = 'not_found' | 'bad_request' | 'conflict';

export class ShareError extends Error {
  constructor(
    readonly code: ShareErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ShareError';
  }
}

/** Most recipients one send may name (O99). The admin's "All members" is not capped. */
export const SHARE_NOTE_MAX = 500;
/** A tag every shared copy carries in the Library. */
export const SHARED_TAG = 'shared';
/** Leg accounts a recipient has none of are left on this placeholder: the builder asks for one. */
export const NO_ACCOUNT = '00000000-0000-0000-0000-000000000000';

// ---------------------------------------------------------------------------
// Database refusals
// ---------------------------------------------------------------------------

function findPgError(error: unknown): { code: string; message: string } | undefined {
  for (let e: unknown = error, i = 0; e && i < 5; e = (e as { cause?: unknown }).cause, i++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
      return { code, message: String((e as { message?: unknown }).message ?? '') };
    }
  }
  return undefined;
}

const sentence = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) + '.' : s);

/** The share_* functions refuse with readable messages; pass them on as ShareErrors. */
async function call<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const pg = findPgError(error);
    if (pg?.code === '22023') throw new ShareError('bad_request', sentence(pg.message));
    if (pg?.code === 'P0002') throw new ShareError('not_found', 'Share not found');
    if (pg?.code === '42501') throw new ShareError('bad_request', sentence(pg.message));
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

export interface ShareMember {
  userId: string;
  memberCode: string;
  displayName: string;
  isAdmin: boolean;
}

const toMember = (r: Record<string, unknown>): ShareMember => ({
  userId: r.user_id as string,
  memberCode: r.member_code as string,
  displayName: r.display_name as string,
  isAdmin: r.is_admin === true,
});

/** The signed-in person's own member ID (shown in Settings). */
export async function myMemberCode(tx: Transaction, userId: string): Promise<string | null> {
  const [row] = await tx.select({ code: users.memberCode }).from(users).where(eq(users.id, userId));
  return row?.code ?? null;
}

/**
 * One member by exact member ID or email, or null. Null for everyone who
 * can't receive shares, so a lookup never says why.
 */
export async function lookupShareMember(
  tx: Transaction,
  query: string,
): Promise<ShareMember | null> {
  const q = query.trim();
  if (!q || q.length > 320) return null;
  const rows = await call(() =>
    tx.execute<Record<string, unknown>>(sql`select * from share_lookup_member(${q})`),
  );
  return rows[0] ? toMember(rows[0]) : null;
}

/** Every member who can receive shares: the admin's picker. Refused for anyone else. */
export async function listShareMembers(tx: Transaction): Promise<ShareMember[]> {
  try {
    const rows = await tx.execute<Record<string, unknown>>(sql`select * from share_list_members()`);
    return rows.map(toMember);
  } catch (error) {
    if (findPgError(error)?.code === '42501') {
      throw new ShareError('bad_request', 'Only the admin can list members.');
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

/** The person-written fields of a record, as a registration would send them. */
type RecordSnapshot = Omit<RegisterLibraryEntryInput, 'builtStrategyId'>;

export interface ShareSnapshot {
  /** A Library share, and Lab shares made before ADR 0072: the record as it was. */
  record?: RecordSnapshot;
  /** A Lab share since ADR 0072: the theory the strategy referred to, if any. */
  theory?: { registrationNumber: string; name: string } | null;
  /** A Lab share only: the strategy as it was when shared. */
  strategy?: {
    name: string;
    description: string;
    tags: string[];
    definition: unknown;
  };
}

type EntryRow = typeof entries.$inferSelect;

function recordSnapshot(row: EntryRow): RecordSnapshot {
  return {
    recordTypeCode: row.recordTypeCode,
    timeframeCode: row.timeframeCode,
    assetClassCode: row.assetClassCode,
    name: row.name,
    category: row.category as RecordSnapshot['category'],
    tags: row.tags,
    shortDescription: row.shortDescription,
    longDescription: row.longDescription,
    assets: row.assets,
    dataRequirements: row.dataRequirements ?? undefined,
    entry: row.entry,
    exit: row.exit,
    frequency: row.frequency as RecordSnapshot['frequency'],
    turnaround: row.turnaround as RecordSnapshot['turnaround'],
    usedBy: row.usedBy as RecordSnapshot['usedBy'],
    trackRecord: row.trackRecord ?? undefined,
    backtestSummary: row.backtestSummary ?? undefined,
    sources: row.sources as RecordSnapshot['sources'],
    relatedEntries: row.relatedEntries,
    direction: row.direction as RecordSnapshot['direction'],
    parameters: row.parameters as RecordSnapshot['parameters'],
    positionSizing: row.positionSizing as RecordSnapshot['positionSizing'],
    stopLoss: row.stopLoss as RecordSnapshot['stopLoss'],
    rebalanceSchedule: row.rebalanceSchedule as RecordSnapshot['rebalanceSchedule'],
    maturity: row.maturity as RecordSnapshot['maturity'],
    keyRisks: row.keyRisks ?? undefined,
    dataNeeds: row.dataNeeds as RecordSnapshot['dataNeeds'],
    universe: row.universe as RecordSnapshot['universe'],
  };
}

async function entryByNumber(tx: Transaction, number: string): Promise<EntryRow> {
  const n = number.trim().toUpperCase();
  const [row] = await tx
    .select()
    .from(entries)
    .where(or(eq(entries.registrationNumber, n), sql`${n} = any(${entries.formerNumbers})`))
    .orderBy(sql`${entries.registrationNumber} = ${n} desc`)
    .limit(1);
  if (!row) throw new ShareError('not_found', `${number} is not in the Library`);
  return row;
}

// ---------------------------------------------------------------------------
// Sharing
// ---------------------------------------------------------------------------

export const shareSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('library'), number: z.string().trim().min(1).max(40) }).strict(),
  z.object({ kind: z.literal('lab'), strategyId: z.string().uuid() }).strict(),
]);
export type ShareSource = z.infer<typeof shareSourceSchema>;

export const createShareSchema = z
  .object({
    /** One thing to share; or `sources` for several at once (N125). */
    source: shareSourceSchema.optional(),
    sources: z.array(shareSourceSchema).min(1, 'Choose what to share').optional(),
    /** Member IDs or emails, exactly as typed. */
    recipients: z.array(z.string().trim().min(1).max(320)).default([]),
    /** The admin only: everyone who can receive shares. */
    allMembers: z.boolean().default(false),
    note: z
      .string()
      .trim()
      .max(SHARE_NOTE_MAX, `Keep the note to ${SHARE_NOTE_MAX} characters`)
      .optional(),
  })
  .strict()
  .refine((d) => Boolean(d.source) !== Boolean(d.sources), {
    message: 'Choose what to share',
    path: ['sources'],
  });
export type CreateShareInput = z.input<typeof createShareSchema>;

async function buildSnapshot(
  tx: Transaction,
  source: ShareSource,
): Promise<{
  kind: ShareKind;
  /** The Library record shared, or the theory the shared strategy refers to (if any). */
  entry: EntryRow | null;
  /** The number the share shows: the record's, or the strategy's own S number. */
  label: string;
  strategyId: string | null;
  snapshot: ShareSnapshot;
}> {
  if (source.kind === 'library') {
    const entry = await entryByNumber(tx, source.number);
    if (entry.status !== 'registered') {
      throw new ShareError(
        'bad_request',
        `${entry.registrationNumber} is retired and can't be shared`,
      );
    }
    return {
      kind: 'library',
      entry,
      label: entry.registrationNumber,
      strategyId: null,
      snapshot: { record: recordSnapshot(entry) },
    };
  }
  // Row-level security limits this to the sender's own strategies.
  const [s] = await tx
    .select()
    .from(strategies)
    .where(and(eq(strategies.id, source.strategyId), isNull(strategies.deletedAt)));
  if (!s) throw new ShareError('not_found', 'Strategy not found');
  if (isFixtureName(s.name)) {
    throw new ShareError('bad_request', 'Test fixtures have no number and can’t be shared');
  }
  // A strategy is shared with its own number; the copy refers to the same theory (ADR 0072).
  if (!s.labNumber) throw new ShareError('bad_request', 'This strategy has no number yet');
  const [entry] = s.libraryEntryId
    ? await tx.select().from(entries).where(eq(entries.id, s.libraryEntryId))
    : [];
  return {
    kind: 'lab',
    entry: entry ?? null,
    label: s.labNumber,
    strategyId: s.id,
    snapshot: {
      theory: entry ? { registrationNumber: entry.registrationNumber, name: entry.name } : null,
      strategy: {
        name: s.name,
        description: s.description,
        tags: s.tags,
        definition: s.draftDefinition,
      },
    },
  };
}

const sourceKey = (s: ShareSource) =>
  s.kind === 'library' ? `library:${s.number.toUpperCase()}` : `lab:${s.strategyId}`;

/**
 * Shares each source with each recipient (one share per pair). All or nothing:
 * a recipient who can't receive shares, a source that can't be shared, or a
 * limit refuses the whole send.
 */
export async function createShares(
  tx: Transaction,
  senderId: string,
  input: CreateShareInput,
): Promise<ShareSummary[]> {
  const parsed = createShareSchema.safeParse(input);
  if (!parsed.success) {
    throw new ShareError('bad_request', parsed.error.issues[0]?.message ?? 'Invalid share');
  }
  const data = parsed.data;
  const own = await myMemberCode(tx, senderId);
  const people = new Map<string, ShareMember>();
  if (data.allMembers) {
    for (const m of await listShareMembers(tx)) people.set(m.userId, m);
  }
  for (const typed of data.recipients) {
    if (own && typed.toUpperCase() === own) {
      throw new ShareError('bad_request', 'You can’t share with yourself');
    }
    const member = await lookupShareMember(tx, typed);
    if (!member) throw new ShareError('bad_request', `${typed}: this member can’t receive shares`);
    people.set(member.userId, member);
  }
  if (people.size === 0) throw new ShareError('bad_request', 'Choose who to share with');

  const unique = new Map<string, ShareSource>();
  for (const src of data.sources ?? (data.source ? [data.source] : [])) {
    unique.set(sourceKey(src), src);
  }
  const many = unique.size > 1;
  // Every source is checked before anything is shared.
  const built = [];
  for (const src of unique.values()) built.push(await buildSnapshot(tx, src));
  const ids: string[] = [];
  for (const { kind, entry, label, strategyId, snapshot } of built) {
    for (const member of people.values()) {
      let rows;
      try {
        rows = await call(() =>
          tx.execute<{ id: string }>(
            sql`select share_create(${member.userId}::uuid, ${kind}, ${entry?.id ?? null}::uuid, ${strategyId}::uuid, ${JSON.stringify(snapshot)}::jsonb, ${data.note ?? null}) as id`,
          ),
        );
      } catch (e) {
        // Say which one, when a send has several.
        if (many && e instanceof ShareError) {
          throw new ShareError(e.code, `${label}: ${e.message}`);
        }
        throw e;
      }
      const id = rows[0]?.id;
      if (!id) throw new Error('share_create returned no id');
      ids.push(id);
    }
  }
  return listShares(tx, senderId, { box: 'sent', ids });
}

// ---------------------------------------------------------------------------
// Reading shares
// ---------------------------------------------------------------------------

export interface ShareSummary {
  id: string;
  kind: ShareKind;
  status: ShareStatus;
  /** The signed-in person's side of it. */
  role: 'sender' | 'recipient';
  sender: { name: string | null; code: string; isAdmin: boolean; label: string };
  recipient: { name: string | null; code: string; label: string };
  sourceNumber: string;
  sourceName: string;
  note: string | null;
  createdAt: Date;
  expiresAt: Date;
  decidedAt: Date | null;
  /** The copy, once accepted (the recipient follows it; the sender sees the number). */
  result: { number: string | null; strategyId: string | null } | null;
}

export interface ShareDetail extends ShareSummary {
  snapshot: ShareSnapshot;
}

type ShareRow = typeof strategyShares.$inferSelect;

function toSummary(r: ShareRow, viewerId: string): ShareSummary {
  const role = r.senderId === viewerId ? 'sender' : 'recipient';
  return {
    id: r.id,
    kind: r.kind as ShareKind,
    status: r.status as ShareStatus,
    role,
    sender: {
      name: r.senderName,
      code: r.senderCode,
      isAdmin: r.senderIsAdmin,
      label: sharePersonLabel(r.senderName, r.senderCode),
    },
    recipient: {
      name: r.recipientName,
      code: r.recipientCode,
      label: sharePersonLabel(r.recipientName, r.recipientCode),
    },
    sourceNumber: r.sourceNumber,
    sourceName: r.sourceName,
    note: r.note,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    decidedAt: r.decidedAt,
    result:
      r.status === 'accepted'
        ? {
            number: r.resultNumber,
            strategyId: role === 'recipient' ? r.resultStrategyId : null,
          }
        : null,
  };
}

/** A pending share past its expiry reads as expired before the daily job marks it. */
function effective(r: ShareRow, now = new Date()): ShareRow {
  return r.status === 'pending' && r.expiresAt <= now ? { ...r, status: 'expired' } : r;
}

export async function listShares(
  tx: Transaction,
  viewerId: string,
  options: { box: 'received' | 'sent'; status?: ShareStatus | undefined; ids?: string[] },
): Promise<ShareSummary[]> {
  const side =
    options.box === 'sent'
      ? eq(strategyShares.senderId, viewerId)
      : eq(strategyShares.recipientId, viewerId);
  const rows = await tx
    .select()
    .from(strategyShares)
    .where(and(side, options.ids ? inArray(strategyShares.id, options.ids) : undefined))
    .orderBy(desc(strategyShares.createdAt))
    // The Sharing page shows the latest 1,000; a send's own shares all come back.
    .limit(options.ids ? options.ids.length : 1000);
  return rows
    .map((r) => effective(r))
    .filter((r) => !options.status || r.status === options.status)
    .map((r) => toSummary(r, viewerId));
}

export async function getShare(
  tx: Transaction,
  viewerId: string,
  id: string,
): Promise<ShareDetail | null> {
  if (!z.string().uuid().safeParse(id).success) return null;
  // Row-level security: only the sender and the recipient read it.
  const [row] = await tx.select().from(strategyShares).where(eq(strategyShares.id, id));
  if (!row) return null;
  const r = effective(row);
  return { ...toSummary(r, viewerId), snapshot: r.snapshot as ShareSnapshot };
}

/** Pending shares waiting for the signed-in person: the Sharing nav count. */
export async function pendingShareCount(tx: Transaction, viewerId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(strategyShares)
    .where(
      and(
        eq(strategyShares.recipientId, viewerId),
        eq(strategyShares.status, 'pending'),
        sql`${strategyShares.expiresAt} > now()`,
      ),
    );
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Answering
// ---------------------------------------------------------------------------

/** Every leg's account becomes `account`: the sender's accounts mean nothing here. */
export function reassignAccounts(definition: unknown, account: string): unknown {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) =>
          k === 'accountId' && typeof x === 'string' ? [k, account] : [k, walk(x)],
        ),
      );
    }
    return v;
  };
  return walk(definition);
}

export interface AcceptedShare {
  kind: ShareKind;
  /** The copy's Library number. */
  number: string;
  /** The copy in Strategy Lab, for a Lab share. */
  strategyId: string | null;
}

/**
 * Accepts a share as its recipient, then closes it. A Library share copies the
 * record with a new number. A Lab share copies the strategy, which gets its own
 * S number and refers to the same theory as the shared one, if any (ADR 0072).
 * A repeated accept returns the first copy.
 */
export async function acceptShare(
  tx: Transaction,
  userId: string,
  shareId: string,
): Promise<AcceptedShare> {
  if (!z.string().uuid().safeParse(shareId).success) {
    throw new ShareError('not_found', 'Share not found');
  }
  const rows = await call(() =>
    tx.execute<Record<string, unknown>>(sql`select * from share_accept_begin(${shareId}::uuid)`),
  );
  const begun = rows[0];
  if (!begun) throw new ShareError('not_found', 'Share not found');
  const kind = begun.kind as ShareKind;
  if (begun.status === 'accepted') {
    return {
      kind,
      number: begun.result_number as string,
      strategyId: (begun.result_strategy_id as string | null) ?? null,
    };
  }
  const snapshot = begun.snapshot as ShareSnapshot;
  const sourceNumber = begun.source_number as string;
  const senderCode = begun.sender_code as string;

  if (kind === 'lab') {
    const copy = await acceptLabShare(tx, userId, shareId, snapshot, sourceNumber);
    await call(() =>
      tx.execute(
        sql`select share_accept_finish(${shareId}::uuid, ${copy.entryId}::uuid, ${copy.strategyId}::uuid)`,
      ),
    );
    return { kind, number: copy.number, strategyId: copy.strategyId };
  }

  if (!snapshot.record) throw new ShareError('bad_request', 'The shared record is missing');
  const shared = snapshot.record;
  const tags = [...new Set([...(shared.tags ?? []), SHARED_TAG])].slice(0, 20);
  // Related numbers that no longer resolve are dropped rather than refusing the copy.
  const related = (shared.relatedEntries ?? []).length
    ? (
        await tx
          .select({ n: entries.registrationNumber })
          .from(entries)
          .where(inArray(entries.registrationNumber, shared.relatedEntries ?? []))
      ).map((r) => r.n)
    : [];
  const record = registerLibraryEntrySchema.safeParse({ ...shared, tags, relatedEntries: related });
  if (!record.success) {
    throw new ShareError(
      'bad_request',
      `The shared record can’t be copied: ${record.error.issues[0]?.message ?? 'invalid'}`,
    );
  }
  const issued = await registerLibraryEntry(tx, userId, record.data, {
    receivedShareId: shareId,
    copiedFrom: sourceNumber,
  });
  await tx.insert(revisions).values({
    entryId: issued.id,
    action: 'create',
    note: `Copied from ${sourceNumber}, shared by ${senderCode}`,
    changedFields: [],
    editedBy: userId,
  });
  await call(() =>
    tx.execute(sql`select share_accept_finish(${shareId}::uuid, ${issued.id}::uuid, null::uuid)`),
  );
  return { kind, number: issued.registrationNumber, strategyId: null };
}

/**
 * The recipient's copy of a shared strategy: its own S number, its legs on the
 * recipient's paper account, and a reference to the same theory as the shared
 * strategy while that theory can still be referred to (not retired).
 */
async function acceptLabShare(
  tx: Transaction,
  userId: string,
  shareId: string,
  snapshot: ShareSnapshot,
  sourceNumber: string,
): Promise<{ strategyId: string; number: string; entryId: string | null }> {
  if (!snapshot.strategy) throw new ShareError('bad_request', 'The shared strategy is missing');
  // A Lab share made before ADR 0072 named the strategy's record by its number.
  const theoryNumber =
    snapshot.theory === undefined
      ? snapshot.record
        ? sourceNumber
        : null
      : (snapshot.theory?.registrationNumber ?? null);
  const [theory] = theoryNumber
    ? await tx
        .select({ id: entries.id, number: entries.registrationNumber })
        .from(entries)
        .where(
          and(
            or(
              eq(entries.registrationNumber, theoryNumber),
              sql`${theoryNumber} = any(${entries.formerNumbers})`,
            ),
            eq(entries.status, 'registered'),
          ),
        )
        .limit(1)
    : [];
  const account = (await preferredLegAccountId(tx)) ?? NO_ACCOUNT;
  // Re-read through the domain so an older stored schema migrates on the way in.
  const definition = reassignAccounts(parseDefinition(snapshot.strategy.definition), account);
  try {
    const copy = await createStrategy(tx, userId, {
      name: snapshot.strategy.name,
      description: snapshot.strategy.description,
      tags: snapshot.strategy.tags,
      definition,
      ...(theory ? { library: { kind: 'entry' as const, registrationNumber: theory.number } } : {}),
      receivedShareId: shareId,
    });
    return { strategyId: copy.id, number: copy.labNumber ?? '', entryId: theory?.id ?? null };
  } catch (error) {
    if (error instanceof StrategyError) throw new ShareError('bad_request', error.message);
    throw error;
  }
}

export async function declineShare(tx: Transaction, shareId: string): Promise<void> {
  await closeShare(tx, shareId, 'declined');
}

export async function withdrawShare(tx: Transaction, shareId: string): Promise<void> {
  await closeShare(tx, shareId, 'withdrawn');
}

async function closeShare(tx: Transaction, shareId: string, status: 'declined' | 'withdrawn') {
  if (!z.string().uuid().safeParse(shareId).success) {
    throw new ShareError('not_found', 'Share not found');
  }
  await call(() => tx.execute(sql`select share_close(${shareId}::uuid, ${status})`));
}

/** Marks pending shares past their 30 days as expired. The worker runs it daily. */
export async function expireShares(db: Database | Transaction): Promise<number> {
  const rows = await db.execute<{ n: number }>(sql`select share_expire() as n`);
  return Number(rows[0]?.n ?? 0);
}

/** Account deletion: withdraws what it sent and declines what it was sent, silently. */
export async function closeSharesForAccount(tx: Transaction): Promise<number> {
  const rows = await tx.execute<{ n: number }>(sql`select share_close_for_account() as n`);
  return Number(rows[0]?.n ?? 0);
}
