import { performanceQuery } from '@tm/contracts';
import { asc, schema, sql, withTenant } from '@tm/db';
import { PageHeader } from '@tm/ui';
import type { Metadata } from 'next';
import { PerformanceView } from '@/components/performance/performance-view';
import { PERFORMANCE_PARAMS, type PerformanceFilters } from '@/lib/performance-text';
import { appDb } from '@/lib/server/db';
import { getProfile } from '@/lib/server/profile';
import { requireTenant } from '@/lib/server/session';

export const metadata: Metadata = { title: 'Performance' };

type SearchParams = Record<string, string | string[] | undefined>;

export default async function PerformancePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const tenant = await requireTenant();
  const profile = await getProfile(tenant);
  const raw = await searchParams;
  const one = (k: string) => (Array.isArray(raw[k]) ? raw[k][0] : raw[k]) || undefined;

  // Unknown or malformed filters from the address bar are dropped, not errors.
  const filters: PerformanceFilters = { mode: 'paper' };
  for (const [key, param] of Object.entries(PERFORMANCE_PARAMS) as [
    keyof PerformanceFilters,
    string,
  ][]) {
    const value = one(param);
    if (value === undefined) continue;
    if (performanceQuery.safeParse({ [key]: value }).success) {
      Object.assign(filters, { [key]: value });
    }
  }

  const { accounts, strategies, versions } = await withTenant(appDb(), tenant, async (tx) => ({
    accounts: await tx
      .select({ id: schema.tradingAccounts.id, name: schema.tradingAccounts.nickname })
      .from(schema.tradingAccounts)
      .orderBy(asc(schema.tradingAccounts.nickname)),
    strategies: await tx
      .select({ id: schema.strategies.id, name: schema.strategies.name })
      .from(schema.strategies)
      .where(sql`${schema.strategies.deletedAt} is null`)
      .orderBy(asc(schema.strategies.name)),
    versions: await tx
      .select({
        id: schema.strategyVersions.id,
        strategyId: schema.strategyVersions.strategyId,
        versionNo: schema.strategyVersions.versionNo,
      })
      .from(schema.strategyVersions)
      .orderBy(asc(schema.strategyVersions.versionNo)),
  }));

  return (
    <>
      <PageHeader
        title="Performance"
        description="Results by strategy, account, asset and period, from reconciled fills. Amounts in US dollars."
      />
      <PerformanceView
        prefs={{ timeZone: profile.timezone, locale: profile.locale }}
        initialFilters={filters}
        accounts={accounts}
        strategies={strategies.map((s) => ({
          ...s,
          versions: versions.filter((v) => v.strategyId === s.id),
        }))}
      />
    </>
  );
}
