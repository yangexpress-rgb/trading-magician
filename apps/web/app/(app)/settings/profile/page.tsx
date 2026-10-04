import { Card } from '@tm/ui';
import type { Metadata } from 'next';
import { getProfile } from '@/lib/server/profile';
import { requireTenant } from '@/lib/server/session';
import { ProfileForm } from './profile-form';

export const metadata: Metadata = { title: 'Profile' };

export default async function ProfileSettingsPage() {
  const tenant = await requireTenant();
  const profile = await getProfile(tenant);
  const timezones = ['UTC', ...Intl.supportedValuesOf('timeZone')];
  return (
    <Card aria-labelledby="profile-heading" className="max-w-xl">
      <h2 id="profile-heading" className="text-lg font-semibold">
        Profile
      </h2>
      <p className="mb-4 text-sm text-ink-muted">Signed in as {tenant.email}</p>
      <ProfileForm profile={profile} timezones={timezones} />
    </Card>
  );
}
