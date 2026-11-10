import { listStrategiesQuery } from '@tm/contracts';
import { listStrategies, schema, type StrategySummary, withTenant } from '@tm/db';
import {
  type DisplayPreferences,
  formatDateTime,
  STATUS_LABELS,
  STRATEGY_STATUSES,
} from '@tm/domain';
import { Badge, EmptyState, LabIcon, ModeBadge, PageHeader, Table, Td, Th } from '@tm/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import {
  ShareCheckAll,
  ShareCheckbox,
  ShareSelectedBar,
  ShareSelection,
} from '@/components/sharing/share-selection';
import { UrlFilterBar } from '@/components/filters/url-filter-bar';
import { StrategyNameLink } from '@/components/strategy/strategy-name';
import { StrategyStatusBadge } from '@/components/strategy-status-badge';
import { formatPct } from '@/lib/backtest-text';
import { isAdmin } from '@/lib/server/admin';
import { appDb } from '@/lib/server/db';
import { getProfile } from '@/lib/server/profile';
import { requireTenant } from '@/lib/server/session';
import { type CopySource, NewStrategyButton } from './new-strategy';
import { RowActions } from './row-actions';
import { bare } from '@/lib/units';
import { TradingStrategyNav } from '@/components/trading/trading-strategy-nav';

export const metadata: Metadata = { title: 'Strategy Lab' };

const UPDATED_PRESETS = { '7d': 7, '30d': 30, '90d': 90 } as const;
const SORTS = {
  updated: 'Recently updated',
  created: 'Recently created',
  number: 'Number',
  theory: 'Theory',
  name: 'Name',
  status: 'Status',
  assets: 'Assets',
  version: 'Version',
  account: 'Account',
  backtest: 'Latest back test %',
} as const;
type SortKey = keyof typeof SORTS;

type SearchParams = Record<string, string | string[] | undefined>;

export default async function StrategyLabPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const tenant = await requireTenant();
  const profile = await getProfile(tenant);
  const prefs = { timeZone: profile.timezone, locale: profile.locale };
  const raw = await searchParams;
  const one = (k: string) => (Array.isArray(raw[k]) ? raw[k][0] : raw[k]) || undefined;

  const parsed = listStrategiesQuery.safeParse({
    q: one('q'),
    status: one('status'),
    instrumentId: one('asset'),
    archived: one('archived'),
    shared: one('shared'),
    sort: one('sort'),
    // Strategy number ascending by default (N188); name and numbers sort A to Z first.
    direction:
      one('dir') ??
      (['name', 'number', 'theory', undefined].includes(one('sort')) ? 'asc' : 'desc'),
  });
  const q = parsed.success ? parsed.data : listStrategiesQuery.parse({});
  const updated = one('updated') as keyof typeof UPDATED_PRESETS | undefined;
  const days = updated ? UPDATED_PRESETS[updated] : undefined;

  const { items, total, instrumentOptions, copySources } = await withTenant(
    appDb(),
    tenant,
    async (tx) => ({
      ...(await listStrategies(tx, {
        search: q.q,
        statuses: q.status,
        instrumentId: q.instrumentId,
        archived: q.archived,
        shared: q.shared,
        sort: q.sort,
        direction: q.direction,
        updatedFrom: days ? new Date(Date.now() - days * 86_400_000) : undefined,
      })),
      instrumentOptions: await tx
        .select({ id: schema.instruments.id, symbol: schema.instruments.symbol })
        .from(schema.instruments)
        .orderBy(schema.instruments.symbol),
      // Every strategy, archived included, is something a new one can be copied from.
      copySources: (
        await listStrategies(tx, {
          archived: 'include',
          sort: 'name',
          direction: 'asc',
          limit: 200,
        })
      ).items.map((s): CopySource => ({
        id: s.id,
        name: s.name,
        description: s.description,
        archived: s.archivedAt !== null,
      })),
    }),
  );
  const filtered = Boolean(
    q.q || q.status || q.instrumentId || days || q.archived !== 'exclude' || q.shared,
  );
  const admin = await isAdmin();
  // Only numbered strategies can be shared (ADR 0056).
  const shareItem = (s: StrategySummary) =>
    s.libraryNumber
      ? {
          source: { kind: 'lab' as const, strategyId: s.id },
          label: `${s.libraryNumber} ${s.name}`,
        }
      : null;
  const shareable = items.map(shareItem).filter((i) => i !== null);

  // Column headers sort the list (N167): the first click sorts ascending, the
  // next descending. Filters stay as they are.
  const sortHref = (key: SortKey) => {
    const params = new URLSearchParams();
    for (const k of ['q', 'status', 'asset', 'updated', 'archived', 'shared']) {
      const v = one(k);
      if (v) params.set(k, v);
    }
    params.set('sort', key);
    params.set('dir', q.sort === key && q.direction === 'asc' ? 'desc' : 'asc');
    return `/strategy-lab?${params.toString()}`;
  };
  const header = (key: SortKey, label: string, numeric = false) => {
    const active = q.sort === key;
    return (
      <Th
        numeric={numeric}
        sort={active ? (q.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
      >
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

  return (
    <>
      <PageHeader
        title="Trading Strategy"
        description="Define entry and exit rules across any mix of assets, test them, then run them on paper."
        actions={<NewStrategyButton sources={copySources} initialCopyFrom={one('copy')} />}
      />
      <TradingStrategyNav />

      {/* Filters apply as they are picked; the rarer ones wait in the Filter menu (N195). */}
      <div className="mb-4">
        <UrlFilterBar
          label="Filter strategies"
          search={{
            param: 'q',
            label: 'Search',
            placeholder: 'Name, number or tag',
            value: q.q ?? '',
          }}
          filters={[
            {
              kind: 'choice',
              key: 'status',
              label: 'Status',
              pinned: true,
              value: q.status?.[0] ?? '',
              options: STRATEGY_STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] })),
            },
            {
              kind: 'choice',
              key: 'asset',
              label: 'Asset',
              pinned: true,
              value: q.instrumentId ?? '',
              options: instrumentOptions.map((i) => ({ value: i.id, label: i.symbol })),
            },
            {
              kind: 'choice',
              key: 'updated',
              label: 'Updated',
              pinned: true,
              value: days ? (updated ?? '') : '',
              options: [
                { value: '7d', label: 'Last 7 days' },
                { value: '30d', label: 'Last 30 days' },
                { value: '90d', label: 'Last 90 days' },
              ],
            },
            {
              kind: 'choice',
              key: 'archived',
              label: 'Archived',
              anyValue: 'exclude',
              value: q.archived,
              options: [
                { value: 'only', label: 'Archived only' },
                { value: 'include', label: 'Current and archived' },
              ],
            },
            {
              kind: 'choice',
              key: 'shared',
              label: 'Origin',
              value: q.shared ? '1' : '',
              options: [{ value: '1', label: 'Shared with me' }],
            },
          ]}
          trailing={[
            {
              kind: 'choice',
              key: 'sort',
              label: 'Sort',
              setting: true,
              anyValue: 'number',
              value: q.sort,
              options: Object.entries(SORTS).map(([value, label]) => ({ value, label })),
            },
          ]}
          keepOnClear={['sort', 'dir']}
          resets={{ sort: ['dir'] }}
        />
      </div>

      {items.length === 0 ? (
        <EmptyState
          icon={<LabIcon />}
          title={filtered ? 'No strategies match' : 'No strategies yet'}
        >
          {filtered
            ? 'Try a different search or clear the filters.'
            : 'Create a strategy to start defining entry and exit rules.'}
        </EmptyState>
      ) : (
        <ShareSelection>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-ink-muted" aria-live="polite">
              {total === 1 ? '1 strategy' : `${total} strategies`}
            </p>
            <ShareSelectedBar isAdmin={admin} noun="strategies" />
          </div>
          <Table label="Strategies">
            <thead>
              <tr>
                <Th>
                  <ShareCheckAll items={shareable} noun="strategies" />
                </Th>
                {header('number', 'Number')}
                {header('theory', 'Theory')}
                {header('name', 'Name')}
                {header('status', 'Status')}
                {header('assets', 'Assets')}
                {header('version', 'Version')}
                {header('account', 'Account')}
                {header('backtest', 'Latest back test %', true)}
                {header('updated', `Updated (${prefs.timeZone})`)}
                <Th>
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => {
                const item = shareItem(s);
                return (
                  <tr key={s.id}>
                    <Td>{item && <ShareCheckbox item={item} />}</Td>
                    {/* Its own Lab number (ADR 0065, ADR 0068); never editable. */}
                    <Td className="whitespace-nowrap font-mono text-xs">
                      {s.labNumber ? (
                        <Link href={`/strategy-lab/${s.id}`}>{s.labNumber}</Link>
                      ) : (
                        <span className="text-ink-muted">—</span>
                      )}
                    </Td>
                    {/* The theory it refers to (N187); blank when its theory was auto-created from it. */}
                    <Td className="whitespace-nowrap font-mono text-xs">
                      {s.theoryNumber && (
                        <Link
                          href={`/library/${s.theoryNumber}`}
                          aria-label={`Theory ${s.theoryNumber}`}
                        >
                          {s.theoryNumber}
                        </Link>
                      )}
                    </Td>
                    <Td>
                      {/* A click opens it; a double-click renames it (N190). */}
                      <StrategyNameLink
                        strategyId={s.id}
                        name={s.name}
                        rowVersion={s.rowVersion}
                        href={`/strategy-lab/${s.id}`}
                        className="font-medium"
                      />
                      {s.archivedAt && (
                        <Badge tone="neutral" className="ml-2">
                          Archived
                        </Badge>
                      )}
                      {s.shared && (
                        <Badge tone="info" icon={false} className="ml-2">
                          Shared
                        </Badge>
                      )}
                      {s.tags.length > 0 && (
                        <p className="mt-0.5 text-xs text-ink-muted">{s.tags.join(' · ')}</p>
                      )}
                    </Td>
                    <Td>
                      <StrategyStatusBadge status={s.status} />
                    </Td>
                    <Td className="text-xs">
                      {s.instruments.length ? s.instruments.map((i) => i.symbol).join(', ') : '—'}
                    </Td>
                    <Td>{s.currentVersionNo ? `v${s.currentVersionNo}` : 'Draft'}</Td>
                    <Td>{s.accountMode ? <ModeBadge mode={s.accountMode} /> : '—'}</Td>
                    <Td numeric>
                      <LatestBacktest run={s.latestBacktest} prefs={prefs} />
                    </Td>
                    <Td className="whitespace-nowrap text-content">
                      {formatDateTime(s.updatedAt, prefs)}
                    </Td>
                    <Td className="text-right">
                      <RowActions
                        strategy={{
                          id: s.id,
                          name: s.name,
                          status: s.status,
                          archived: s.archivedAt !== null,
                          rowVersion: s.rowVersion,
                          libraryNumber: s.libraryNumber,
                        }}
                        isAdmin={admin}
                      />
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

const RUN_LABELS = {
  queued: 'Queued',
  running: 'Running',
  failed: 'Failed',
  canceled: 'Canceled',
} as const;

function LatestBacktest({
  run,
  prefs,
}: {
  run: StrategySummary['latestBacktest'];
  prefs: DisplayPreferences;
}) {
  if (!run) return <span className="text-ink-muted">Not run</span>;
  if (run.status !== 'completed') {
    return <span className="text-ink-muted">{RUN_LABELS[run.status]}</span>;
  }
  return (
    <>
      <span className="text-content">{bare(formatPct(run.netReturnPct, true))}</span>
      {run.finishedAt && (
        <p className="mt-0.5 whitespace-nowrap text-xs text-ink-muted">
          {formatDateTime(run.finishedAt, prefs)}
        </p>
      )}
    </>
  );
}
