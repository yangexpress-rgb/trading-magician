'use client';

import { ApiError, type NotificationListDto } from '@tm/contracts';
import { formatDateTime, type DisplayPreferences } from '@tm/domain';
import { Alert, Badge, Button, cx, EmptyState, PageHeader } from '@tm/ui';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { apiClient } from '@/lib/api-client';
import { subscribeLive } from '@/lib/live-events';
import { NOTIFICATION_LABELS } from '@/lib/order-text';

/**
 * In-app notifications (§16.3): strategy start and stop, triggers, rejections,
 * fills, disconnects, stale prices, pauses and reconciliation mismatches.
 */
export function NotificationsView({ prefs }: { prefs: DisplayPreferences }) {
  const [data, setData] = useState<NotificationListDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await apiClient.notifications.list({ limit: 100 }));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load notifications.');
    }
  }, []);
  useEffect(() => {
    void load();
    return subscribeLive({ onChange: () => void load() });
  }, [load]);

  async function markAll() {
    try {
      await apiClient.notifications.markRead({ all: true });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not mark notifications read.');
    }
  }

  return (
    <>
      <PageHeader
        title="Notifications"
        description="What your paper strategies did and anything that needs your attention."
        actions={
          data && data.unread > 0 ? (
            <Button onClick={() => void markAll()}>Mark all as read</Button>
          ) : undefined
        }
      />
      {error && <Alert>{error}</Alert>}
      {!data && !error && <p className="text-sm">Loading notifications…</p>}
      {data && data.notifications.length === 0 && (
        <EmptyState title="Nothing yet">
          Notifications appear when a strategy starts or stops, its rules trigger, orders fill or
          are rejected, and when something pauses trading.
        </EmptyState>
      )}
      {data && data.notifications.length > 0 && (
        <ul
          aria-label="Notifications"
          className="divide-y divide-line rounded-lg border border-line bg-surface"
        >
          {data.notifications.map((n) => {
            const kind = NOTIFICATION_LABELS[n.kind];
            return (
              <li
                key={n.id}
                aria-label={`${n.title}${n.read ? '' : ', unread'}`}
                className={cx(
                  'flex flex-wrap items-start gap-3 px-4 py-3',
                  !n.read && 'bg-surface-2',
                )}
              >
                <Badge tone={kind.tone}>{kind.label}</Badge>
                <div className="min-w-0 flex-1">
                  <p className={cx('text-sm', !n.read && 'font-semibold')}>
                    {n.link ? (
                      <Link href={n.link} className="underline">
                        {n.title}
                      </Link>
                    ) : (
                      n.title
                    )}
                    {!n.read && <span className="sr-only"> (unread)</span>}
                  </p>
                  {n.body && <p className="mt-0.5 text-sm text-ink-muted">{n.body}</p>}
                </div>
                <time dateTime={n.createdAt} className="text-xs whitespace-nowrap text-ink-muted">
                  {formatDateTime(n.createdAt, prefs)}
                </time>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
