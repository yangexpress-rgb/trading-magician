import { listStrategiesQuery } from '@tm/contracts';
import { listStrategies, schema, type StrategySummary, withTenant } from '@tm/db';
import {
  type DisplayPreferences,
  formatDateTime,
  STATUS_LABELS,
  STRATEGY_STATUSES,
} from '@tm/domain';
import {
  Badge,
  buttonClasses,
  EmptyState,
  LabIcon,
  ModeBadge,
  PageHeader,
  SelectField,
  Table,
  Td,
  TextField,
  Th,
} from '@tm/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { StrategyStatusBadge } from '@/components/strategy-status-badge';
import { formatPct } from '@/lib/backtest-text';
import { appDb } from '@/lib/server/db';
import { getProfile } from '@/lib/server/profile';
import { requireTenant } from '@/lib/server/session';
import { NewStrategyButton } from './new-strategy';
import { RowActions } from './row-actions';

export const metadata: Metadata = { title: 'Strategy Lab' };

const UPDATED_PRESETS = { '7d': 7, '30d': 30, '90d': 90 } as const;
const SORTS = {
  updated: 'Recently updated',
  created: 'Recently created',
  name: 'Name',
  status: 'Status',
} as const;

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
    sort: one('sort'),
    direction: one('sort') === 'name' ? 'asc' : 'desc',
  });
  const q = parsed.success ? parsed.data : listStrategiesQuery.parse({});
  const updated = one('updated') as keyof typeof UPDATED_PRESETS | undefined;
  const days = updated ? UPDATED_PRESETS[updated] : undefined;

  const { items, total, instrumentOptions } = await withTenant(appDb(), tenant, async (tx) => ({
    ...(await listStrategies(tx, {
      search: q.q,
      statuses: q.status,
      instrumentId: q.instrumentId,
      archived: q.archived,
      sort: q.sort,
      direction: q.direction,
      updatedFrom: days ? new Date(Date.now() - days * 86_400_000) : undefined,
    })),
    instrumentOptions: await tx
      .select({ id: schema.instruments.id, symbol: schema.instruments.symbol })
      .from(schema.instruments)
      .orderBy(schema.instruments.symbol),
  }));
  const filtered = Boolean(q.q || q.status || q.instrumentId || days || q.archived !== 'exclude');

  return (
    <>
      <PageHeader
        title="Strategy Lab"
        description="Define entry and exit rules across any mix of assets, test them, then run them on paper."
        actions={<NewStrategyButton />}
      />

      <form
        role="search"
        aria-label="Filter strategies"
        className="mb-4 grid grid-cols-1 items-end gap-3 sm:grid-cols-3 lg:grid-cols-7"
      >
        <div className="sm:col-span-3 lg:col-span-2">
          <TextField
            label="Search"
            name="q"
            type="search"
            defaultValue={q.q ?? ''}
            placeholder="Name, description or tag"
          />
        </div>
        <SelectField label="Status" name="status" defaultValue={q.status?.[0] ?? ''}>
          <option value="">Any status</option>
          {STRATEGY_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </SelectField>
        <SelectField label="Asset" name="asset" defaultValue={q.instrumentId ?? ''}>
          <option value="">Any asset</option>
          {instrumentOptions.map((i) => (
            <option key={i.id} value={i.id}>
              {i.symbol}
            </option>
          ))}
        </SelectField>
        <SelectField label="Updated" name="updated" defaultValue={days ? updated : ''}>
          <option value="">Any time</option>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
          <option value="90d">Last 90 days</option>
        </SelectField>
        <SelectField label="Sort by" name="sort" defaultValue={q.sort}>
          {Object.entries(SORTS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </SelectField>
        <div className="flex gap-2">
          <SelectField label="Show" name="archived" defaultValue={q.archived}>
            <option value="exclude">Current</option>
            <option value="only">Archived</option>
            <option value="include">All</option>
          </SelectField>
        </div>
        <div className="flex gap-2 sm:col-span-3 lg:col-span-7">
          <button type="submit" className={buttonClasses('secondary', 'sm')}>
            Apply filters
          </button>
          {filtered && (
            <Link href="/strategy-lab" className={buttonClasses('ghost', 'sm')}>
              Clear
            </Link>
          )}
        </div>
      </form>

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
        <>
          <p className="mb-2 text-sm text-ink-muted" aria-live="polite">
            {total === 1 ? '1 strategy' : `${total} strategies`}
          </p>
          <Table label="Strategies">
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Status</Th>
                <Th>Assets</Th>
                <Th>Version</Th>
                <Th>Account</Th>
                <Th>Latest back test</Th>
                <Th>Updated ({prefs.timeZone})</Th>
                <Th>
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.id}>
                  <Td>
                    <Link href={`/strategy-lab/${s.id}`} className="font-medium">
                      {s.name}
                    </Link>
                    {s.archivedAt && (
                      <Badge tone="neutral" className="ml-2">
                        Archived
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
                  <Td>
                    <LatestBacktest run={s.latestBacktest} prefs={prefs} />
                  </Td>
                  <Td className="whitespace-nowrap">{formatDateTime(s.updatedAt, prefs)}</Td>
                  <Td className="text-right">
                    <RowActions
                      strategy={{
                        id: s.id,
                        name: s.name,
                        status: s.status,
                        archived: s.archivedAt !== null,
                        rowVersion: s.rowVersion,
                      }}
                    />
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </>
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
      <span className="tabular-nums">{formatPct(run.netReturnPct, true)}</span>
      {run.finishedAt && (
        <p className="mt-0.5 whitespace-nowrap text-xs text-ink-muted">
          {formatDateTime(run.finishedAt, prefs)}
        </p>
      )}
    </>
  );
}
