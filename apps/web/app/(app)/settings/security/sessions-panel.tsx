'use client';

import { formatDateTime, type DisplayPreferences } from '@tm/domain';
import { Badge, Button, Table, Td, Th } from '@tm/ui';
import { useCallback, useEffect, useState } from 'react';
import { authClient } from '@/lib/auth-client';

interface SessionRow {
  id: string;
  token: string;
  createdAt: Date;
  userAgent?: string | null;
}

export function SessionsPanel({
  currentSessionId,
  prefs,
}: {
  currentSessionId: string;
  prefs: DisplayPreferences;
}) {
  const [sessions, setSessions] = useState<SessionRow[]>();

  const load = useCallback(async () => {
    const { data } = await authClient.listSessions();
    setSessions((data as SessionRow[] | null) ?? []);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (!sessions) return <p className="text-sm text-ink-muted">Loading sessions…</p>;
  const others = sessions.filter((s) => s.id !== currentSessionId);

  return (
    <div className="space-y-3">
      <Table label="Active sessions">
        <thead>
          <tr>
            <Th>Signed in ({prefs.timeZone})</Th>
            <Th>Device</Th>
            <Th>
              <span className="sr-only">Action</span>
            </Th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => (
            <tr key={s.id}>
              <Td className="text-content">{formatDateTime(s.createdAt, prefs)}</Td>
              <Td className="max-w-xs truncate">{s.userAgent ?? 'Unknown device'}</Td>
              <Td className="text-right">
                {s.id === currentSessionId ? (
                  <Badge tone="info">This device</Badge>
                ) : (
                  <Button
                    size="sm"
                    onClick={async () => {
                      await authClient.revokeSession({ token: s.token });
                      await load();
                    }}
                  >
                    Sign out
                  </Button>
                )}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
      {others.length > 0 && (
        <Button
          onClick={async () => {
            await authClient.revokeOtherSessions();
            await load();
          }}
        >
          Sign out all other devices
        </Button>
      )}
    </div>
  );
}
