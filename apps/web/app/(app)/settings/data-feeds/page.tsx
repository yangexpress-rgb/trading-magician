import type { Metadata } from 'next';
import { FeedsView } from '@/components/integrations/feeds-view';
import { getProfile } from '@/lib/server/profile';
import { requireTenant } from '@/lib/server/session';

export const metadata: Metadata = { title: 'Data feeds' };

export default async function DataFeedsPage() {
  const tenant = await requireTenant();
  const profile = await getProfile(tenant);
  return <FeedsView prefs={{ timeZone: profile.timezone, locale: profile.locale }} />;
}
