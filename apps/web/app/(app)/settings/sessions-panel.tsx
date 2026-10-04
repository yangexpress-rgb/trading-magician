'use client';

import { useCallback, useEffect, useState } from 'react';
import { authClient } from '@/lib/auth-client';

interface SessionRow {
  id: string;
  token: string;
  createdAt: Date;
  userAgent?: string | null;
  ipAddress?: string | null;
}

export function SessionsPanel({
  currentSessionId,
  timezone,
}: {
  currentSessionId: string;
  timezone: string;
}) {
  const [sessions, setSessions] = useState<SessionRow[]>();
  const fmt = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: timezone,
  });

  const load = useCallback(async () => {
    const { data } = await authClient.listSessions();
    setSessions((data as SessionRow[] | null) ?? []);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (!sessions) return <p className="muted">Loading sessions…</p>;
  const others = sessions.filter((s) => s.id !== currentSessionId);

  return (
    <div className="stack">
      <table>
        <thead>
          <tr>
            <th scope="col">Signed in</th>
            <th scope="col">Device</th>
            <th scope="col">
              <span className="muted">Action</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => (
            <tr key={s.id}>
              <td>{fmt.format(new Date(s.createdAt))}</td>
              <td>{s.userAgent ?? 'Unknown device'}</td>
              <td>
                {s.id === currentSessionId ? (
                  <span className="badge">This device</span>
                ) : (
                  <button
                    type="button"
                    onClick={async () => {
                      await authClient.revokeSession({ token: s.token });
                      await load();
                    }}
                  >
                    Sign out
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {others.length > 0 && (
        <button
          type="button"
          onClick={async () => {
            await authClient.revokeOtherSessions();
            await load();
          }}
        >
          Sign out all other devices
        </button>
      )}
    </div>
  );
}
