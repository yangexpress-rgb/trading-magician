import { and, count, desc, inArray, isNull } from 'drizzle-orm';
import type { Transaction } from './client';
import type { NOTIFICATION_KINDS } from './schema';
import { notifications } from './schema';

/**
 * In-app notifications (Design v1.0 §16.3; ADR 0014). Producers call `notify`
 * inside the transaction that made the change, so a notification exists only
 * if the change committed. A `dedupeKey` keeps replays and retries to one.
 */

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

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
