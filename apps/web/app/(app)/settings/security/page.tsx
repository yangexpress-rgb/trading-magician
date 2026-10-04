import { Card } from '@tm/ui';
import type { Metadata } from 'next';
import { getProfile } from '@/lib/server/profile';
import { requireTenant } from '@/lib/server/session';
import { DeleteAccount } from './delete-account';
import { SessionsPanel } from './sessions-panel';

export const metadata: Metadata = { title: 'Notifications and security' };

export default async function SecurityPage() {
  const tenant = await requireTenant();
  const profile = await getProfile(tenant);
  return (
    <div className="space-y-6">
      <Card aria-labelledby="notifications-heading">
        <h2 id="notifications-heading" className="text-lg font-semibold">
          Notifications
        </h2>
        <p className="mt-1 text-sm text-ink-muted">
          In-app notifications for strategy and order events arrive with paper execution. Email and
          push channels will be configurable here.
        </p>
      </Card>
      <Card aria-labelledby="sessions-heading">
        <h2 id="sessions-heading" className="mb-3 text-lg font-semibold">
          Active sessions
        </h2>
        <SessionsPanel
          currentSessionId={tenant.sessionId}
          prefs={{ timeZone: profile.timezone, locale: profile.locale }}
        />
      </Card>
      <Card aria-labelledby="danger-heading" className="border-danger/40">
        <h2 id="danger-heading" className="mb-3 text-lg font-semibold">
          Delete account
        </h2>
        <DeleteAccount />
      </Card>
    </div>
  );
}
