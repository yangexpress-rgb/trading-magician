import { adminAuditEvents, adminListUsers } from '@tm/db';
import { formatDateTime } from '@tm/domain';
import { Button, Card, EmptyState, SelectField, Table, Td, Th } from '@tm/ui';
import Link from 'next/link';
import { z } from 'zod';
import { asAdmin, requireAdmin } from '@/lib/server/admin';
import { getProfile } from '@/lib/server/profile';

export const dynamic = 'force-dynamic';

const PAGE = 100;

const FILTERS = [
  { value: '', label: 'Everything' },
  { value: 'admin.', label: 'Admin actions' },
  { value: 'invite.', label: 'Invite codes' },
  { value: 'account.', label: 'Accounts' },
  { value: 'strategy.', label: 'Strategies' },
  { value: 'order.', label: 'Orders' },
  { value: 'data_feed.', label: 'Data feeds' },
] as const;

const query = z.object({
  action: z.enum(FILTERS.map((f) => f.value) as [string, ...string[]]).catch(''),
  user: z.string().uuid().optional().catch(undefined),
  before: z.coerce.date().optional().catch(undefined),
});

/** Context values are identifiers and counts (§16.2); show them compactly. */
function describe(context: Record<string, unknown>, emails: Map<string, string>): string {
  return Object.entries(context)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => {
      if (k === 'adminId' && typeof v === 'string') return `by ${emails.get(v) ?? v}`;
      return `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`;
    })
    .join(' · ');
}

export default async function AdminAuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const tenant = await requireAdmin();
  const params = query.parse(await searchParams);
  const [events, users] = await asAdmin(async (tx) => [
    await adminAuditEvents(tx, {
      limit: PAGE,
      ...(params.action ? { action: params.action } : {}),
      ...(params.user ? { userId: params.user } : {}),
      ...(params.before ? { before: params.before } : {}),
    }),
    await adminListUsers(tx),
  ]);
  const emails = new Map(users.map((u) => [u.id, u.email]));
  const profile = await getProfile(tenant);
  const prefs = { timeZone: profile.timezone, locale: profile.locale };
  const last = events.at(-1);
  const older = new URLSearchParams({
    ...(params.action ? { action: params.action } : {}),
    ...(params.user ? { user: params.user } : {}),
    ...(last ? { before: last.occurredAt.toISOString() } : {}),
  });

  return (
    <Card aria-labelledby="audit-heading">
      <h2 id="audit-heading" className="text-lg font-semibold">
        Audit log
      </h2>
      <p className="mt-1 mb-4 text-sm text-ink-muted">
        Every recorded action across all accounts, newest first. Entries cannot be changed or
        deleted.
      </p>
      <form className="mb-4 flex flex-wrap items-end gap-3" method="get">
        <div className="w-48">
          <SelectField label="Show" name="action" defaultValue={params.action}>
            {FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </SelectField>
        </div>
        <div className="w-64">
          <SelectField label="Person" name="user" defaultValue={params.user ?? ''}>
            <option value="">Everyone</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.email}
              </option>
            ))}
          </SelectField>
        </div>
        <Button type="submit">Filter</Button>
      </form>
      {events.length === 0 ? (
        <EmptyState title="Nothing recorded">No audit entries match.</EmptyState>
      ) : (
        <Table label="Audit log">
          <thead>
            <tr>
              <Th>When ({prefs.timeZone})</Th>
              <Th>Action</Th>
              <Th>Account</Th>
              <Th>By</Th>
              <Th>Details</Th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id}>
                <Td className="whitespace-nowrap text-content">
                  {formatDateTime(e.occurredAt, prefs, {
                    dateStyle: 'medium',
                    timeStyle: 'medium',
                  })}
                </Td>
                <Td className="font-mono text-xs">{e.action}</Td>
                <Td className="text-xs">
                  {e.userEmail ??
                    (e.resourceType === 'user' && e.resourceId
                      ? (emails.get(e.resourceId) ?? '—')
                      : '—')}
                </Td>
                <Td className="text-xs">{e.actorType === 'user' ? 'The person' : 'System'}</Td>
                <Td className="max-w-md text-xs break-words text-ink-muted">
                  {describe(e.context, emails)}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {events.length === PAGE && (
        <p className="mt-4">
          <Link href={`/admin/audit?${older.toString()}`}>Older entries</Link>
        </p>
      )}
    </Card>
  );
}
