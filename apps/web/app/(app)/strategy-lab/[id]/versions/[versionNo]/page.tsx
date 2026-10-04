import { getStrategy, getStrategyVersion, schema, StrategyError, withTenant } from '@tm/db';
import { formatDateTime } from '@tm/domain';
import { Badge, Card, PageHeader } from '@tm/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { VersionSummary } from '@/components/strategy/version-summary';
import { appDb } from '@/lib/server/db';
import { getProfile } from '@/lib/server/profile';
import { requireTenant } from '@/lib/server/session';

export const metadata: Metadata = { title: 'Strategy version' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function VersionPage({
  params,
}: {
  params: Promise<{ id: string; versionNo: string }>;
}) {
  const { id, versionNo } = await params;
  const n = Number(versionNo);
  if (!UUID.test(id) || !/^\d{1,9}$/.test(versionNo) || n < 1) notFound();
  const tenant = await requireTenant();
  const profile = await getProfile(tenant);
  const { strategy, version, instruments, accounts } = await withTenant(
    appDb(),
    tenant,
    async (tx) => ({
      strategy: await getStrategy(tx, id),
      version: await getStrategyVersion(tx, id, n),
      instruments: await tx
        .select({ id: schema.instruments.id, symbol: schema.instruments.symbol })
        .from(schema.instruments),
      accounts: await tx
        .select({ id: schema.tradingAccounts.id, nickname: schema.tradingAccounts.nickname })
        .from(schema.tradingAccounts),
    }),
  ).catch((e: unknown) => {
    if (e instanceof StrategyError && e.code === 'not_found') notFound();
    throw e;
  });

  const isCurrent = strategy.currentVersion?.id === version.id;
  const matchesDraft = strategy.definitionHash === version.definitionHash;
  const started = strategy.statusHistory.filter(
    (h) => h.toStatus === 'actively_executing' && h.versionNo === version.versionNo,
  );

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href={`/strategy-lab/${strategy.id}`}>← Back to {strategy.name}</Link>
      </p>
      <PageHeader
        title={`${strategy.name} · version ${version.versionNo}`}
        description={`Saved ${formatDateTime(version.createdAt, {
          timeZone: profile.timezone,
          locale: profile.locale,
        })}. Saved versions can't be changed.`}
        actions={
          <>
            {isCurrent && <Badge tone="info">Current version</Badge>}
            <Badge tone={matchesDraft ? 'ok' : 'warn'}>
              {matchesDraft ? 'Same as the draft' : 'Differs from the draft'}
            </Badge>
          </>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
        <div className="min-w-0">
          <VersionSummary
            definition={version.definition}
            symbols={new Map(instruments.map((i) => [i.id, i.symbol]))}
            accounts={new Map(accounts.map((a) => [a.id, a.nickname]))}
            baseCurrency={profile.baseCurrency}
          />
        </div>
        <aside>
          <Card aria-labelledby="version-runs-heading">
            <h2 id="version-runs-heading" className="text-lg font-semibold">
              Started with this version
            </h2>
            {started.length === 0 ? (
              <p className="mt-1 text-sm text-ink-muted">Never started.</p>
            ) : (
              <ul className="mt-2 space-y-2 text-sm">
                {started.map((h) => (
                  <li key={h.changedAt.toISOString()}>
                    {formatDateTime(h.changedAt, {
                      timeZone: profile.timezone,
                      locale: profile.locale,
                    })}
                    {h.acknowledgedWarnings.length > 0 && (
                      <span className="block text-ink-muted">
                        Acknowledged {h.acknowledgedWarnings.length}{' '}
                        {h.acknowledgedWarnings.length === 1 ? 'warning' : 'warnings'}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </aside>
      </div>
    </>
  );
}
