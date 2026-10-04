import { schema, withTenant } from '@tm/db';
import { Card } from '@tm/ui';
import type { Metadata } from 'next';
import { appDb } from '@/lib/server/db';
import { requireTenant } from '@/lib/server/session';

export const metadata: Metadata = { title: 'Subscription and billing' };

const LIMIT_LABELS: Record<string, string> = {
  savedStrategies: 'Saved strategies',
  activeStrategies: 'Active strategies',
  backtestRunsPerDay: 'Back tests per day',
  connectedAccounts: 'Connected accounts',
  paperIntegrations: 'Paper trading',
  liveData: 'Live market data',
  realIntegrations: 'Real-money trading',
};

export default async function BillingPage() {
  const tenant = await requireTenant();
  const [entitlement] = await withTenant(appDb(), tenant, (tx) =>
    tx.select().from(schema.entitlements),
  );
  const limits = (entitlement?.limits ?? {}) as Record<string, number | boolean>;
  return (
    <Card aria-labelledby="billing-heading" className="max-w-xl space-y-3">
      <h2 id="billing-heading" className="text-lg font-semibold">
        Subscription and billing
      </h2>
      <p className="text-sm text-ink-muted">
        You are on the <strong className="text-ink">{entitlement?.planCode ?? 'dev'}</strong> plan.
        Paid plans and billing arrive in a later phase.
      </p>
      <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-2 text-sm">
        {Object.entries(LIMIT_LABELS).map(([key, label]) => {
          const value = limits[key];
          if (value === undefined) return null;
          return (
            <div key={key} className="contents">
              <dt className="text-ink-muted">{label}</dt>
              <dd className="text-right font-medium">
                {typeof value === 'boolean' ? (value ? 'Included' : 'Not included') : value}
              </dd>
            </div>
          );
        })}
      </dl>
    </Card>
  );
}
