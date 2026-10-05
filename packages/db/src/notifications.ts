import { and, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { recordAudit } from './audit';
import type { Transaction } from './client';
import { NOTIFICATION_KINDS, notifications, profiles } from './schema';

/**
 * In-app notifications (Design v1.0 §16.3; ADR 0014). Producers call `notify`
 * inside the transaction that made the change, so a notification exists only
 * if the change committed. A `dedupeKey` keeps replays and retries to one.
 * Kinds the person muted are not created at all; the audit trail still records the event.
 */

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/**
 * Kinds that always show because they stop trading (Phase 4 decision 4):
 * risk pauses, reconciliation mismatches and disconnects cannot be muted, nor
 * can billing changes, which can pause strategies (ADR 0023).
 */
export const ALWAYS_SHOWN_KINDS = [
  'risk_pause',
  'reconciliation_mismatch',
  'disconnect',
  'billing',
] as const satisfies readonly NotificationKind[];

export interface NotificationPrefs {
  /** Kinds the person turned off. Never includes an always-shown kind. */
  muted: NotificationKind[];
}

const isAlwaysShown = (kind: string) => (ALWAYS_SHOWN_KINDS as readonly string[]).includes(kind);

/** Reads stored preferences defensively: unknown or locked kinds are dropped. */
export function parseNotificationPrefs(raw: unknown): NotificationPrefs {
  const muted = (raw as { muted?: unknown } | null)?.muted;
  if (!Array.isArray(muted)) return { muted: [] };
  return {
    muted: NOTIFICATION_KINDS.filter((k) => muted.includes(k) && !isAlwaysShown(k)),
  };
}

export async function getNotificationPrefs(tx: Transaction): Promise<NotificationPrefs> {
  const [row] = await tx.select({ prefs: profiles.notificationPrefs }).from(profiles);
  return parseNotificationPrefs(row?.prefs);
}

export async function updateNotificationPrefs(
  tx: Transaction,
  input: { userId: string; muted: readonly string[] },
): Promise<NotificationPrefs> {
  const before = await getNotificationPrefs(tx);
  const prefs = parseNotificationPrefs({ muted: input.muted });
  await tx
    .update(profiles)
    .set({ notificationPrefs: prefs, rowVersion: sql`${profiles.rowVersion} + 1` })
    .where(eq(profiles.userId, input.userId));
  await recordAudit(tx, {
    userId: input.userId,
    actorType: 'user',
    action: 'notification_prefs.updated',
    resourceType: 'profile',
    resourceId: input.userId,
    context: { from: before.muted, to: prefs.muted },
  });
  return prefs;
}

export interface NotifyInput {
  userId: string;
  kind: NotificationKind;
  title: string;
  body?: string | undefined;
  link?: string | undefined;
  resourceType?: string | undefined;
  resourceId?: string | undefined;
  dedupeKey?: string | undefined;
}

export async function notify(tx: Transaction, n: NotifyInput): Promise<void> {
  if (!isAlwaysShown(n.kind)) {
    const [row] = await tx
      .select({ prefs: profiles.notificationPrefs })
      .from(profiles)
      .where(eq(profiles.userId, n.userId));
    if (parseNotificationPrefs(row?.prefs).muted.includes(n.kind)) return;
  }
  await tx
    .insert(notifications)
    .values({
      userId: n.userId,
      kind: n.kind,
      title: n.title.slice(0, 200),
      body: (n.body ?? '').slice(0, 1000),
      link: n.link ?? null,
      resourceType: n.resourceType ?? null,
      resourceId: n.resourceId ?? null,
      dedupeKey: n.dedupeKey ?? null,
    })
    .onConflictDoNothing({ target: [notifications.userId, notifications.dedupeKey] });
}

export interface NotificationRow {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  link: string | null;
  createdAt: string;
  read: boolean;
}

export async function listNotifications(
  tx: Transaction,
  options: { limit?: number; unreadOnly?: boolean } = {},
): Promise<{ notifications: NotificationRow[]; unread: number }> {
  const rows = await tx
    .select()
    .from(notifications)
    .where(options.unreadOnly ? isNull(notifications.readAt) : undefined)
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(options.limit ?? 50);
  const [unread] = await tx
    .select({ n: count() })
    .from(notifications)
    .where(isNull(notifications.readAt));
  return {
    notifications: rows.map((r) => ({
      id: r.id,
      kind: r.kind as NotificationKind,
      title: r.title,
      body: r.body,
      link: r.link,
      createdAt: r.createdAt.toISOString(),
      read: r.readAt !== null,
    })),
    unread: unread?.n ?? 0,
  };
}

/** Marks the given notifications read, or all of them. Returns how many changed. */
export async function markNotificationsRead(
  tx: Transaction,
  ids: string[] | 'all',
): Promise<number> {
  const where = [isNull(notifications.readAt)];
  if (ids !== 'all') {
    if (ids.length === 0) return 0;
    where.push(inArray(notifications.id, ids));
  }
  const rows = await tx
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(...where))
    .returning({ id: notifications.id });
  return rows.length;
}

/** Unread count only, for the header. */
export async function unreadNotifications(tx: Transaction): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(notifications)
    .where(isNull(notifications.readAt));
  return row?.n ?? 0;
}
