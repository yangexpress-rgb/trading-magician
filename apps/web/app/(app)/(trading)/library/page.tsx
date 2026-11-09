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
import {
  Badge,
  buttonClasses,
  EmptyState,
  LibraryIcon,
  PageHeader,
  SelectField,
  Table,
  Td,
  TextField,
  Th,
} from '@tm/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import {
  ShareCheckAll,
  ShareCheckbox,
  ShareSelectedBar,
  ShareSelection,
} from '@/components/sharing/share-selection';
import { BUILT_LABELS, codeMeaning, codeOption, versionsByLabel } from '@/lib/library-text';
import { isAdmin } from '@/lib/server/admin';
import { appDb } from '@/lib/server/db';
import { requireTenant } from '@/lib/server/session';

export const metadata: Metadata = { title: 'Strategy Library' };

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
        title="Strategy Library"
        description="Every strategy we know about, built in Strategy Lab or not, with one permanent registration number each."
        actions={
          <Link href="/library/new" className={buttonClasses('primary')}>
            Register a strategy
          </Link>
        }
      />

      {/* Keyed by the query, so Clear also resets the selects (they are uncontrolled). */}
      <form
        key={JSON.stringify(q)}
        role="search"
        aria-label="Filter the library"
        className="mb-4 grid-fields items-end gap-3"
      >
        <div className="sm:col-span-2">
          <TextField
            label="Search"
            name="q"
            type="search"
            defaultValue={q.q ?? ''}
            placeholder="Number, name, description or tag"
          />
        </div>
        <SelectField label="Asset class" name="asset" defaultValue={q.asset ?? ''}>
          <option value="">Any asset class</option>
          {current.tables.assetClass.map((c) => (
            <option key={c.code} value={c.code}>
              {codeOption(c)}
            </option>
          ))}
        </SelectField>
        <SelectField label="Timeframe" name="timeframe" defaultValue={q.timeframe ?? ''}>
          <option value="">Any timeframe</option>
          {current.tables.timeframe.map((c) => (
            <option key={c.code} value={c.code}>
              {codeOption(c)}
            </option>
          ))}
        </SelectField>
        <SelectField label="Category" name="category" defaultValue={q.category ?? ''}>
          <option value="">Any category</option>
          {LIBRARY_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABELS[c]}
            </option>
          ))}
        </SelectField>
        <SelectField label="Built" name="built" defaultValue={q.built ?? ''}>
          <option value="">Built or not</option>
          <option value="built">Built</option>
          <option value="not_built">Not built</option>
        </SelectField>
        <SelectField label="Direction" name="side" defaultValue={q.side ?? ''}>
          <option value="">Any direction</option>
          {LIBRARY_DIRECTIONS.map((d) => (
            <option key={d} value={d}>
              {DIRECTION_LABELS[d]}
            </option>
          ))}
        </SelectField>
        <SelectField label="Maturity" name="maturity" defaultValue={q.maturity ?? ''}>
          <option value="">Any maturity</option>
          {LIBRARY_MATURITIES.map((m) => (
            <option key={m} value={m}>
              {MATURITY_LABELS[m]}
            </option>
          ))}
        </SelectField>
        <SelectField label="Data needs" name="data" defaultValue={q.data ?? ''}>
          <option value="">Any data</option>
          {DATA_NEEDS.map((d) => (
            <option key={d} value={d}>
              {DATA_NEED_LABELS[d]}
            </option>
          ))}
        </SelectField>
        <SelectField label="Status" name="status" defaultValue={q.status}>
          <option value="all">Registered and retired</option>
          <option value="registered">Registered</option>
          <option value="retired">Retired</option>
        </SelectField>
        <SelectField label="Whose" name="mine" defaultValue={q.mine ?? ''}>
          <option value="">Everyone’s</option>
          <option value="registered">Registered by me</option>
          <option value="shared">Shared with me</option>
        </SelectField>
        <SelectField label="Sort by" name="sort" defaultValue={sortKey}>
          {Object.entries(SORTS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </SelectField>
        <div className="col-span-full flex gap-2">
          <button type="submit" className={buttonClasses('secondary', 'sm')}>
            Apply filters
          </button>
          {filtered && (
            <Link href="/library" className={buttonClasses('ghost', 'sm')}>
              Clear
            </Link>
          )}
        </div>
      </form>

      {items.length === 0 ? (
        <EmptyState icon={<LibraryIcon />} title={filtered ? 'No entries match' : 'No entries yet'}>
          {filtered
            ? 'Try a different search or clear the filters.'
            : 'Register a strategy to start the library.'}
        </EmptyState>
      ) : (
        <ShareSelection>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-ink-muted" aria-live="polite">
              {total === 1 ? '1 entry' : `${total} entries`}
            </p>
            <ShareSelectedBar isAdmin={admin} noun="records" />
          </div>
          <Table label="Strategy Library entries">
            <thead>
              <tr>
                <Th>
                  <ShareCheckAll items={shareable} noun="records" />
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
