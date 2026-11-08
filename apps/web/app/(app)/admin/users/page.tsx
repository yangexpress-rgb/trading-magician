import { adminListUsers, type AdminUser } from '@tm/db';
import { formatDateTime } from '@tm/domain';
import { Badge, Card, Table, Td, Th } from '@tm/ui';
import Link from 'next/link';
import { AdminButton } from '@/components/admin/admin-forms';
import { asAdmin, requireAdmin } from '@/lib/server/admin';
import { getProfile } from '@/lib/server/profile';
import { resetPassword, setUserLocked } from '../actions';

export const dynamic = 'force-dynamic';

function Status({ user }: { user: AdminUser }) {
  if (user.deletedAt) return <Badge tone="neutral">Deleted</Badge>;
  if (user.lockedAt) return <Badge tone="danger">Locked</Badge>;
  return <Badge tone="ok">Active</Badge>;
}

export default async function AdminUsersPage() {
  const tenant = await requireAdmin();
  const me = tenant.userId;
  const users = await asAdmin(adminListUsers);
  const profile = await getProfile(tenant);
  const prefs = { timeZone: profile.timezone, locale: profile.locale };
  const when = (d: Date | null) => (d ? formatDateTime(d, prefs) : '—');

  return (
    <Card aria-labelledby="users-heading">
      <h2 id="users-heading" className="text-lg font-semibold">
        Users
      </h2>
      <p className="mt-1 mb-4 text-sm text-ink-muted">
        Locking someone signs them out everywhere and stops them signing in until you unlock them.
        Their paper strategies keep running; they are not deleted. Times are in {prefs.timeZone}.
      </p>
      <Table label="Users">
        <thead>
          <tr>
            <Th>Person</Th>
            <Th>Status</Th>
            <Th>Plan</Th>
            <Th numeric>Strategies</Th>
            <Th>Joined</Th>
            <Th>Last active</Th>
            <Th>
              <span className="sr-only">Actions</span>
            </Th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <Td>
                <p className="font-medium">
                  {u.name} {u.isAdmin && <Badge tone="info">Admin</Badge>}
                </p>
                <p className="text-xs text-ink-muted">{u.email}</p>
                {u.inviteNote && <p className="text-xs text-ink-muted">Invite: {u.inviteNote}</p>}
              </Td>
              <Td>
                <Status user={u} />
              </Td>
              <Td>{u.planCode ?? '—'}</Td>
              <Td numeric>
                {u.strategies}
                {u.runningStrategies > 0 && ` (${u.runningStrategies} running)`}
              </Td>
              <Td className="text-data">{when(u.createdAt)}</Td>
              <Td className="text-data">{when(u.lastSeenAt)}</Td>
              <Td className="min-w-56">
                {u.id === me ? (
                  <span className="text-xs text-ink-muted">This is you</span>
                ) : u.deletedAt ? null : (
                  <div className="flex flex-wrap items-start gap-2">
                    {!u.isAdmin &&
                      (u.lockedAt ? (
                        <AdminButton
                          action={setUserLocked}
                          fields={{ userId: u.id, locked: 'false' }}
                        >
                          Unlock
                        </AdminButton>
                      ) : (
                        <AdminButton
                          action={setUserLocked}
                          fields={{ userId: u.id, locked: 'true' }}
                          variant="danger"
                          confirm={`Lock ${u.email}? They are signed out at once and cannot sign in until you unlock them.`}
                        >
                          Lock
                        </AdminButton>
                      ))}
                    <AdminButton
                      action={resetPassword}
                      fields={{ userId: u.id }}
                      confirm={`Reset the password for ${u.email}? They are signed out and need the temporary password to sign in.`}
                      secretsLabel="Temporary password"
                    >
                      Reset password
                    </AdminButton>
                    <Link href={`/admin/audit?user=${u.id}`} className="self-center text-xs">
                      Audit trail
                    </Link>
                  </div>
                )}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}
