import type { Metadata } from 'next';
import { PlatformsView } from '@/components/integrations/platforms-view';
import { getProfile } from '@/lib/server/profile';
import { requireTenant } from '@/lib/server/session';

export const metadata: Metadata = { title: 'Trading platforms' };

export default async function AccountsPage() {
  const tenant = await requireTenant();
  const profile = await getProfile(tenant);
  return <PlatformsView prefs={{ timeZone: profile.timezone, locale: profile.locale }} />;
}
