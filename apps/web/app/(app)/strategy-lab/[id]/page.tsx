import { getStrategy, StrategyError, withTenant } from '@tm/db';
import { formatDateTime, STATUS_LABELS } from '@tm/domain';
import { Card, ModeBadge, PageHeader } from '@tm/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { StrategyStatusBadge } from '@/components/strategy-status-badge';
import { appDb } from '@/lib/server/db';
import { getProfile } from '@/lib/server/profile';
import { requireTenant } from '@/lib/server/session';

export const metadata: Metadata = { title: 'Strategy' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function StrategyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const tenant = await requireTenant();
  const profile = await getProfile(tenant);
  const prefs = { timeZone: profile.timezone, locale: profile.locale };
  const strategy = await withTenant(appDb(), tenant, (tx) => getStrategy(tx, id)).catch(
    (e: unknown) => {
      if (e instanceof StrategyError && e.code === 'not_found') notFound();
      throw e;
    },
  );

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/strategy-lab">← All strategies</Link>
      </p>
      <PageHeader
        title={strategy.name}
        description={strategy.description || undefined}
        actions={
          <>
            <StrategyStatusBadge status={strategy.status} />
            <ModeBadge mode="paper" />
          </>
        }
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2" aria-labelledby="rules-heading">
          <h2 id="rules-heading" className="text-lg font-semibold">
            Rules
          </h2>
          <p className="mt-1 text-sm text-ink-muted">
            The Entry and Exit condition builder, planned orders and risk settings open here in the
            next update. This draft already carries the default paper risk limits.
          </p>
        </Card>
        <Card aria-labelledby="versions-heading">
          <h2 id="versions-heading" className="text-lg font-semibold">
            Versions
          </h2>
          {strategy.versions.length === 0 ? (
            <p className="mt-1 text-sm text-ink-muted">
              Draft only. A version is saved when the strategy starts.
            </p>
          ) : (
            <ul className="mt-2 space-y-1 text-sm">
              {strategy.versions.map((v) => (
                <li key={v.id}>
                  v{v.versionNo}
                  {v.id === strategy.currentVersion?.id && ' (current)'} ·{' '}
                  {formatDateTime(v.createdAt, prefs)}
                </li>
              ))}
            </ul>
          )}
          {strategy.hasUnpublishedChanges && strategy.currentVersion && (
            <p className="mt-2 text-sm text-ink-muted">
              The draft has changes since the current version.
            </p>
          )}
          {strategy.statusHistory.length > 0 && (
            <>
              <h3 className="mt-4 text-sm font-semibold">Status history</h3>
              <ul className="mt-1 space-y-1 text-sm">
                {strategy.statusHistory.map((h) => (
                  <li key={`${h.changedAt.toISOString()}-${h.toStatus}`}>
                    {STATUS_LABELS[h.fromStatus]} → {STATUS_LABELS[h.toStatus]} ·{' '}
                    {formatDateTime(h.changedAt, prefs)}
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>
      </div>
    </>
  );
}
