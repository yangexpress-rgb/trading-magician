import { adminListInvites, inviteState, type InviteState } from '@tm/db';
import { formatDateTime } from '@tm/domain';
import { Badge, Card, EmptyState, Table, Td, Th, type Tone } from '@tm/ui';
import { AdminButton, MintInvitesForm } from '@/components/admin/admin-forms';
import { asAdmin, requireAdmin } from '@/lib/server/admin';
import { getProfile } from '@/lib/server/profile';
import { changeInvite, mintInvites } from '../actions';

export const dynamic = 'force-dynamic';

const STATE: Record<InviteState, { label: string; tone: Tone }> = {
  open: { label: 'Open', tone: 'ok' },
  used: { label: 'Used', tone: 'neutral' },
  stuck: { label: 'Sign-up unfinished', tone: 'warn' },
  expired: { label: 'Expired or revoked', tone: 'neutral' },
};

export default async function AdminInvitesPage() {
  const tenant = await requireAdmin();
  const invites = await asAdmin(adminListInvites);
  const profile = await getProfile(tenant);
  const prefs = { timeZone: profile.timezone, locale: profile.locale };
  const when = (d: Date | null) => (d ? formatDateTime(d, prefs) : '—');
  const now = new Date();

  return (
    <div className="space-y-6">
      <Card aria-labelledby="mint-heading">
        <h2 id="mint-heading" className="text-lg font-semibold">
          Create invite codes
        </h2>
        <p className="mt-1 mb-4 text-sm text-ink-muted">
          Each code lets one person sign up. Codes are shown once, right after you create them: only
          a fingerprint is stored, so a lost code cannot be shown again (create another).
        </p>
        <MintInvitesForm action={mintInvites} />
      </Card>
      <Card aria-labelledby="invites-heading">
        <h2 id="invites-heading" className="mb-3 text-lg font-semibold">
          Invite codes
        </h2>
        {invites.length === 0 ? (
          <EmptyState title="No invite codes yet">Create one above.</EmptyState>
        ) : (
          <Table label="Invite codes">
            <thead>
              <tr>
                <Th>Note</Th>
                <Th>Status</Th>
                <Th>Created ({prefs.timeZone})</Th>
                <Th>Expires</Th>
                <Th>Used by</Th>
                <Th>
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {invites.map((i) => {
                const state = inviteState(i, now);
                return (
                  <tr key={i.id}>
                    <Td>{i.note ?? <span className="text-ink-muted">No note</span>}</Td>
                    <Td>
                      <Badge tone={STATE[state].tone}>{STATE[state].label}</Badge>
                    </Td>
                    <Td className="text-content">{when(i.createdAt)}</Td>
                    <Td className="text-content">{i.expiresAt ? when(i.expiresAt) : 'Never'}</Td>
                    <Td>{i.claimedByEmail ?? (i.claimedBy ? 'Deleted account' : '—')}</Td>
                    <Td className="min-w-40">
                      {state === 'open' && (
                        <AdminButton
                          action={changeInvite}
                          fields={{ inviteId: i.id, change: 'revoke' }}
                          variant="danger"
                          confirm="Revoke this invite code? Nobody can sign up with it afterwards."
                        >
                          Revoke
                        </AdminButton>
                      )}
                      {state === 'stuck' && (
                        <AdminButton
                          action={changeInvite}
                          fields={{ inviteId: i.id, change: 'release' }}
                        >
                          Release
                        </AdminButton>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
