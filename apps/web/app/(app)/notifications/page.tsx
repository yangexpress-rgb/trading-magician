import type { Metadata } from 'next';
import { NotificationsView } from '@/components/notifications-view';
import { getProfile } from '@/lib/server/profile';
import { requireTenant } from '@/lib/server/session';

export const metadata: Metadata = { title: 'Notifications' };

export default async function NotificationsPage() {
  const tenant = await requireTenant();
  const profile = await getProfile(tenant);
  return <NotificationsView prefs={{ timeZone: profile.timezone, locale: profile.locale }} />;
}
