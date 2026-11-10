import { listLibraryQuery } from '@tm/contracts';
import {
  getCurrentConvention,
  listConventionVersions,
  listLibraryEntries,
  withTenant,
} from '@tm/db';
import {
  CATEGORY_LABELS,
  DATA_NEED_LABELS,
  DATA_NEEDS,
  DIRECTION_LABELS,
  LIBRARY_CATEGORIES,
  LIBRARY_DIRECTIONS,
  LIBRARY_MATURITIES,
  MATURITY_LABELS,
} from '@tm/domain';
import { Badge, buttonClasses, EmptyState, LibraryIcon, PageHeader, Table, Td, Th } from '@tm/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import {
  ShareCheckAll,
  ShareCheckbox,
  ShareSelectedBar,
  ShareSelection,
} from '@/components/sharing/share-selection';
import { UrlFilterBar } from '@/components/filters/url-filter-bar';
import { BUILT_LABELS, codeMeaning, codeOption, versionsByLabel } from '@/lib/library-text';
import { isAdmin } from '@/lib/server/admin';
import { appDb } from '@/lib/server/db';
import { requireTenant } from '@/lib/server/session';
import { TradingStrategyNav } from '@/components/trading/trading-strategy-nav';

export const metadata: Metadata = { title: 'Theory Library' };

type SearchParams = Record<string, string | string[] | undefined>;

const SORTS = {
  number: 'Registration number',
  name: 'Name',
  asset: 'Asset class',
  timeframe: 'Timeframe',
  category: 'Category',
  maturity: 'Maturity',
  built: 'Built',
  status: 'Status',
  registered: 'Registration date',
} as const;
type SortKey = keyof typeof SORTS;
/** Sorts the database does itself; the rest sort here, by the text shown (N168). */
const DB_SORTS = ['number', 'name', 'registered'] as const;
const isSortKey = (k: string | undefined): k is SortKey => k !== undefined && k in SORTS;

/** The Strategy Library catalogue (ADR 0051): every registered strategy, built or not. */
export default async function LibraryPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const tenant = await requireTenant();
  const raw = await searchParams;
  const one = (k: string) => (Array.isArray(raw[k]) ? raw[k][0] : raw[k]) || undefined;
  const sortKey: SortKey = isSortKey(one('sort')) ? (one('sort') as SortKey) : 'number';
  const dbSort = (DB_SORTS as readonly string[]).includes(sortKey) ? sortKey : 'number';
  const parsed = listLibraryQuery.safeParse({
    q: one('q'),
    asset: one('asset'),
    timeframe: one('timeframe'),
    category: one('category'),
    built: one('built'),
    side: one('side'),
    maturity: one('maturity'),
    data: one('data'),
    status: one('status'),
    mine: one('mine'),
    sort: dbSort,
    direction: one('direction') ?? (sortKey === 'registered' ? 'desc' : 'asc'),
  });
  const q = parsed.success ? parsed.data : listLibraryQuery.parse({});

  const {
    items: listed,
    total,
    current,
    versions,
  } = await withTenant(appDb(), tenant, async (tx) => ({
    ...(await listLibraryEntries(tx, {
      search: q.q,
      assetClassCode: q.asset,
      timeframeCode: q.timeframe,
      category: q.category,
      built: q.built,
      side: q.side,
      maturity: q.maturity,
      dataNeed: q.data,
      status: q.status,
      mine: q.mine,
      viewerId: tenant.userId,
      sort: q.sort,
      direction: q.direction,
    })),
    current: await getCurrentConvention(tx),
    versions: await listConventionVersions(tx),
  }));
  const tables = versionsByLabel(versions);
  const assetText = (e: (typeof listed)[number]) => {
    const t = tables.get(e.conventionVersion);
    return t ? codeMeaning(t.assetClass, e.assetClassCode) : e.assetClassCode;
  };
  const timeframeText = (e: (typeof listed)[number]) => {
    const t = tables.get(e.conventionVersion);
    return t ? codeMeaning(t.timeframe, e.timeframeCode) : e.timeframeCode;
  };
  // Column headers sort the list (N168): the first click ascending, the next
  // descending. Ties keep registration-number order.
  const sortValue: Partial<Record<SortKey, (e: (typeof listed)[number]) => string | number>> = {
    asset: assetText,
    timeframe: timeframeText,
    category: (e) => CATEGORY_LABELS[e.category],
    maturity: (e) => LIBRARY_MATURITIES.indexOf(e.maturity),
    built: (e) => BUILT_LABELS[e.builtStatus],
    status: (e) => e.status,
  };
  const valueOf = sortValue[sortKey];
  const items = valueOf
    ? [...listed].sort((a, b) => {
        const va = valueOf(a);
        const vb = valueOf(b);
        const c =
          typeof va === 'number' && typeof vb === 'number'
            ? va - vb
            : String(va).localeCompare(String(vb), undefined, { sensitivity: 'base' });
        return (q.direction === 'desc' ? -c : c) || a.sequenceNo - b.sequenceNo;
      })
    : listed;
  const sortHref = (key: SortKey) => {
    const params = new URLSearchParams();
    for (const k of [
      'q',
      'asset',
      'timeframe',
      'category',
      'built',
      'side',
      'maturity',
      'data',
      'status',
      'mine',
    ]) {
      const v = one(k);
      if (v) params.set(k, v);
    }
    params.set('sort', key);
    params.set('direction', sortKey === key && q.direction === 'asc' ? 'desc' : 'asc');
    return `/library?${params.toString()}`;
  };
  const header = (key: SortKey, label: string) => {
    const active = sortKey === key;
    return (
      <Th sort={active ? (q.direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
        <Link
          href={sortHref(key)}
          className={`inline-flex items-center gap-1 no-underline hover:text-ink ${active ? 'text-ink' : 'text-ink-muted'}`}
        >
          {label}
          <span aria-hidden="true" className={active ? '' : 'opacity-30'}>
            {active && q.direction === 'asc' ? '▲' : '▼'}
          </span>
          <span className="sr-only">
            {active && q.direction === 'asc' ? ', sort descending' : ', sort ascending'}
          </span>
        </Link>
      </Th>
    );
  };
  const admin = await isAdmin();
  // Retired records can't be shared (ADR 0056).
  const shareItem = (e: (typeof items)[number]) => ({
    source: { kind: 'library' as const, number: e.registrationNumber },
    label: `${e.registrationNumber} ${e.name}`,
  });
  const shareable = items.filter((e) => e.status === 'registered').map(shareItem);
  const filtered = Boolean(
    q.q ||
    q.asset ||
    q.timeframe ||
    q.category ||
    q.built ||
    q.side ||
    q.maturity ||
    q.data ||
    q.mine ||
    q.status !== 'all',
  );

  return (
    <>
      <PageHeader
        title="Trading Strategy"
        description="Every theory we know about, built in Strategy Lab or not, with one permanent registration number each."
        actions={
          <Link href="/library/new" className={buttonClasses('primary')}>
            Register a theory
          </Link>
        }
      />
      <TradingStrategyNav />

      {/* Filters apply as they are picked; most wait in the Filter menu (N195). */}
      <div className="mb-4">
        <UrlFilterBar
          label="Filter the library"
          search={{
            param: 'q',
            label: 'Search',
            placeholder: 'Number, name, description or tag',
            value: q.q ?? '',
          }}
          filters={[
            {
              kind: 'choice',
              key: 'asset',
              label: 'Asset class',
              pinned: true,
              value: q.asset ?? '',
              options: current.tables.assetClass.map((c) => ({
                value: c.code,
                label: codeOption(c),
              })),
            },
            {
              kind: 'choice',
              key: 'timeframe',
              label: 'Timeframe',
              pinned: true,
              value: q.timeframe ?? '',
              options: current.tables.timeframe.map((c) => ({
                value: c.code,
                label: codeOption(c),
              })),
            },
            {
              kind: 'choice',
              key: 'category',
              label: 'Category',
              pinned: true,
              value: q.category ?? '',
              options: LIBRARY_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] })),
            },
            {
              kind: 'choice',
              key: 'built',
              label: 'Built',
              pinned: true,
              value: q.built ?? '',
              options: [
                { value: 'built', label: 'Built' },
                { value: 'not_built', label: 'Not built' },
              ],
            },
            {
              kind: 'choice',
              key: 'side',
              label: 'Direction',
              value: q.side ?? '',
              options: LIBRARY_DIRECTIONS.map((d) => ({ value: d, label: DIRECTION_LABELS[d] })),
            },
            {
              kind: 'choice',
              key: 'maturity',
              label: 'Maturity',
              value: q.maturity ?? '',
              options: LIBRARY_MATURITIES.map((m) => ({ value: m, label: MATURITY_LABELS[m] })),
            },
            {
              kind: 'choice',
              key: 'data',
              label: 'Data needs',
              value: q.data ?? '',
              options: DATA_NEEDS.map((d) => ({ value: d, label: DATA_NEED_LABELS[d] })),
            },
            {
              kind: 'choice',
              key: 'status',
              label: 'Status',
              anyValue: 'all',
              value: q.status,
              options: [
                { value: 'registered', label: 'Registered' },
                { value: 'retired', label: 'Retired' },
              ],
            },
            {
              kind: 'choice',
              key: 'mine',
              label: 'Whose',
              value: q.mine ?? '',
              options: [
                { value: 'registered', label: 'Registered by me' },
                { value: 'shared', label: 'Shared with me' },
              ],
            },
          ]}
          trailing={[
            {
              kind: 'choice',
              key: 'sort',
              label: 'Sort',
              setting: true,
              anyValue: 'number',
              value: sortKey,
              options: Object.entries(SORTS).map(([value, label]) => ({ value, label })),
            },
          ]}
          keepOnClear={['sort', 'direction']}
          resets={{ sort: ['direction'] }}
        />
      </div>

      {items.length === 0 ? (
        <EmptyState icon={<LibraryIcon />} title={filtered ? 'No entries match' : 'No entries yet'}>
          {filtered
            ? 'Try a different search or clear the filters.'
            : 'Register a theory to start the library.'}
        </EmptyState>
      ) : (
        <ShareSelection>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-ink-muted" aria-live="polite">
              {total === 1 ? '1 entry' : `${total} entries`}
            </p>
            <ShareSelectedBar isAdmin={admin} noun="theories" />
          </div>
          <Table label="Theory Library entries">
            <thead>
              <tr>
                <Th>
                  <ShareCheckAll items={shareable} noun="theories" />
                </Th>
                {header('number', 'Number')}
                {header('name', 'Name')}
                {header('asset', 'Asset class')}
                {header('timeframe', 'Timeframe')}
                {header('category', 'Category')}
                {header('maturity', 'Maturity')}
                {header('built', 'Built')}
                {header('status', 'Status')}
              </tr>
            </thead>
            <tbody>
              {items.map((e) => {
                return (
                  <tr key={e.id}>
                    <Td>{e.status === 'registered' && <ShareCheckbox item={shareItem(e)} />}</Td>
                    <Td className="whitespace-nowrap font-mono font-semibold">
                      <Link href={`/library/${e.registrationNumber}`}>{e.registrationNumber}</Link>
                    </Td>
                    <Td>
                      <Link href={`/library/${e.registrationNumber}`} className="font-medium">
                        {e.name}
                      </Link>
                      <p className="mt-0.5 max-w-prose text-xs text-ink-muted">
                        {e.shortDescription}
                      </p>
                    </Td>
                    <Td className="whitespace-nowrap">{assetText(e)}</Td>
                    <Td className="whitespace-nowrap">{timeframeText(e)}</Td>
                    <Td className="whitespace-nowrap">{CATEGORY_LABELS[e.category]}</Td>
                    <Td className="whitespace-nowrap">{MATURITY_LABELS[e.maturity]}</Td>
                    <Td>
                      <Badge tone={e.builtStatus === 'built' ? 'ok' : 'neutral'}>
                        {BUILT_LABELS[e.builtStatus]}
                      </Badge>
                    </Td>
                    <Td>
                      {e.status === 'retired' ? (
                        <Badge tone="warn">Retired</Badge>
                      ) : (
                        <span className="text-ink-muted">Registered</span>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </ShareSelection>
      )}
    </>
  );
}
