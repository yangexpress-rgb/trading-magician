import { listOrdersQuery } from '@tm/contracts';
import { asc, schema, sql, withTenant } from '@tm/db';
import type { Metadata } from 'next';
import { OrdersView } from '@/components/orders/orders-view';
import { FILTER_PARAMS, type OrderFilters } from '@/components/orders/use-orders';
import { appDb } from '@/lib/server/db';
import { getProfile } from '@/lib/server/profile';
import { requireTenant } from '@/lib/server/session';

export const metadata: Metadata = { title: 'Orders' };

type SearchParams = Record<string, string | string[] | undefined>;

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const tenant = await requireTenant();
  const profile = await getProfile(tenant);
  const raw = await searchParams;
  const one = (k: string) => (Array.isArray(raw[k]) ? raw[k][0] : raw[k]) || undefined;

  // Unknown or malformed filters from the address bar are dropped, not errors.
  const filters: OrderFilters = { view: 'all' };
  for (const [key, param] of Object.entries(FILTER_PARAMS) as [keyof OrderFilters, string][]) {
    const value = one(param);
    if (value === undefined) continue;
    const parsed = listOrdersQuery.safeParse({ [key]: value });
    if (parsed.success) Object.assign(filters, { [key]: value });
  }

  const { strategies, instruments } = await withTenant(appDb(), tenant, async (tx) => ({
    strategies: await tx
      .select({ id: schema.strategies.id, name: schema.strategies.name })
      .from(schema.strategies)
      .where(sql`${schema.strategies.deletedAt} is null`)
      .orderBy(asc(schema.strategies.name)),
    instruments: await tx
      .select({ id: schema.instruments.id, symbol: schema.instruments.symbol })
      .from(schema.instruments)
      .orderBy(asc(schema.instruments.symbol)),
  }));

  return (
    <OrdersView
      prefs={{ timeZone: profile.timezone, locale: profile.locale }}
      initialFilters={filters}
      started={one('started')}
      strategies={strategies}
      instruments={instruments}
    />
  );
}
