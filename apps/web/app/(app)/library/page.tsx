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
  registered: 'Registration date',
} as const;

/** The Strategy Library catalogue (ADR 0051): every registered strategy, built or not. */
export default async function LibraryPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const tenant = await requireTenant();
  const raw = await searchParams;
  const one = (k: string) => (Array.isArray(raw[k]) ? raw[k][0] : raw[k]) || undefined;
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
    sort: one('sort'),
    direction: one('direction') ?? (one('sort') === 'registered' ? 'desc' : 'asc'),
  });
  const q = parsed.success ? parsed.data : listLibraryQuery.parse({});

  const { items, total, current, versions } = await withTenant(appDb(), tenant, async (tx) => ({
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
        <SelectField label="Sort by" name="sort" defaultValue={q.sort}>
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
                <Th>Number</Th>
                <Th>Name</Th>
                <Th>Asset class</Th>
                <Th>Timeframe</Th>
                <Th>Category</Th>
                <Th>Maturity</Th>
                <Th>Built</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {items.map((e) => {
                const t = tables.get(e.conventionVersion);
                return (
                  <tr key={e.id}>
                    <Td>{e.status === 'registered' && <ShareCheckbox item={shareItem(e)} />}</Td>
                    <Td className="whitespace-nowrap font-mono font-semibold">
                      <Link href={`/library/${e.registrationNumber}`}>{e.registrationNumber}</Link>
                      {e.formerNumbers.length > 0 && (
                        <p className="mt-0.5 text-xs font-normal text-ink-muted">
                          Formerly {e.formerNumbers.join(', ')}
                        </p>
                      )}
                    </Td>
                    <Td>
                      <Link href={`/library/${e.registrationNumber}`} className="font-medium">
                        {e.name}
                      </Link>
                      <p className="mt-0.5 max-w-prose text-xs text-ink-muted">
                        {e.shortDescription}
                      </p>
                    </Td>
                    <Td className="whitespace-nowrap">
                      {t ? codeMeaning(t.assetClass, e.assetClassCode) : e.assetClassCode}
                    </Td>
                    <Td className="whitespace-nowrap">
                      {t ? codeMeaning(t.timeframe, e.timeframeCode) : e.timeframeCode}
                    </Td>
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
