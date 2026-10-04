import { getStrategy, schema, StrategyError, withTenant } from '@tm/db';
import { formatDateTime, STATUS_LABELS } from '@tm/domain';
import { Card, ModeBadge, PageHeader } from '@tm/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { StrategyStatusBadge } from '@/components/strategy-status-badge';
import { appDb } from '@/lib/server/db';
import { getProfile } from '@/lib/server/profile';
import { requireTenant } from '@/lib/server/session';
import { StrategyEditor } from './strategy-editor';

export const metadata: Metadata = { title: 'Strategy' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function StrategyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const tenant = await requireTenant();
  const profile = await getProfile(tenant);
  const prefs = { timeZone: profile.timezone, locale: profile.locale };
  const loaded = await withTenant(appDb(), tenant, async (tx) => ({
    strategy: await getStrategy(tx, id),
    instruments: await tx
      .select({
        id: schema.instruments.id,
        symbol: schema.instruments.symbol,
        displayName: schema.instruments.displayName,
        assetClass: schema.instruments.assetClass,
      })
      .from(schema.instruments)
      .orderBy(schema.instruments.symbol),
  })).catch((e: unknown) => {
    if (e instanceof StrategyError && e.code === 'not_found') notFound();
    throw e;
  });
  const { strategy, instruments } = loaded;

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
      <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
        <div className="min-w-0">
          <StrategyEditor
            strategyId={strategy.id}
            status={strategy.status}
            initialDefinition={strategy.definition}
            initialRowVersion={strategy.rowVersion}
            instruments={instruments}
          />
        </div>
        <aside className="space-y-4">
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
        </aside>
      </div>
    </>
  );
}
