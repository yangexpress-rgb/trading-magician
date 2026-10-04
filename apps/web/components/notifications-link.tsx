'use client';

import { Badge } from '@tm/ui';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { apiClient } from '@/lib/api-client';
import { subscribeLive } from '@/lib/live-events';

/** Header link to in-app notifications (§16.3) with the unread count, kept live. */
export function NotificationsLink() {
  const [unread, setUnread] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      apiClient.notifications.list({ unread: true, limit: 1 }).then(
        (r) => !cancelled && setUnread(r.unread),
        () => undefined,
      );
    void load();
    const unsubscribe = subscribeLive({ onChange: () => void load() });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
  return (
    <Link
      href="/notifications"
      className="inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm text-ink-muted hover:bg-surface-2 hover:text-ink"
    >
      Notifications
      {unread !== null && unread > 0 && (
        <Badge tone="info" icon={false}>
          {unread}
          <span className="sr-only"> unread</span>
        </Badge>
      )}
    </Link>
  );
}
