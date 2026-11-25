import { listCompanions, withTenant } from '@tm/db';
import { Card } from '@tm/ui';
import type { Metadata } from 'next';
import { CompanionPaused, researchStorage } from '@/components/research/companion-status';
import { appDb } from '@/lib/server/db';
import { serverEnv } from '@/lib/server/env';
import { getProfile } from '@/lib/server/profile';
import { requireTenant } from '@/lib/server/session';
import { CompanionPanel } from './companion-panel';

export const metadata: Metadata = { title: 'Local research storage' };
export const dynamic = 'force-dynamic';

/**
 * Settings › Local research storage (storage separation S2, ADR 0116): pair
 * or unpair the Local Companion that keeps research data on your own
 * computer. Trading never depends on it.
 */
export default async function ResearchStoragePage() {
  const tenant = await requireTenant();
  const profile = await getProfile(tenant);
  const env = serverEnv();
  const [companions, storage] = await Promise.all([
    withTenant(appDb(), tenant, (tx) => listCompanions(tx)),
    researchStorage(tenant),
  ]);
  return (
    <Card aria-labelledby="research-storage-heading">
      <h2 id="research-storage-heading" className="text-lg font-semibold">
        Local research storage
      </h2>
      <p className="mt-1 mb-4 text-sm text-ink-muted">
        The Local Companion keeps research data, such as ML training data and pattern scans, on your
        own computer and sends back only the results the app uses. Trading never depends on it.
      </p>
      <CompanionPaused status={storage} />
      <CompanionPanel
        companions={companions}
        apiBase={`${new URL(env.APP_URL).origin}/api/companion/v1`}
        prefs={{ timeZone: profile.timezone, locale: profile.locale }}
      />
    </Card>
  );
}
