import { myMemberCode, withTenant } from '@tm/db';
import { Card } from '@tm/ui';
import type { Metadata } from 'next';
import { appDb } from '@/lib/server/db';
import { getProfile } from '@/lib/server/profile';
import { requireTenant } from '@/lib/server/session';
import { ProfileForm } from './profile-form';

export const metadata: Metadata = { title: 'Profile' };

export default async function ProfileSettingsPage() {
  const tenant = await requireTenant();
  const profile = await getProfile(tenant);
  const timezones = ['UTC', ...Intl.supportedValuesOf('timeZone')];
  const memberCode = await withTenant(appDb(), tenant, (tx) => myMemberCode(tx, tenant.userId));
  return (
    <Card aria-labelledby="profile-heading" className="max-w-xl">
      <h2 id="profile-heading" className="text-lg font-semibold">
        Profile
      </h2>
      <p className="text-sm text-ink-muted">Signed in as {tenant.email}</p>
      {memberCode && (
        <p className="mb-4 text-sm text-ink-muted">
          Your member ID is <span className="font-mono font-semibold text-ink">{memberCode}</span>.
          Give it to people who want to share a strategy with you.
        </p>
      )}
      <ProfileForm profile={profile} timezones={timezones} />
    </Card>
  );
}
