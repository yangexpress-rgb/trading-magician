import { listStrategiesQuery } from '@tm/contracts';
import { listStrategies, schema, type StrategySummary, withTenant } from '@tm/db';
import {
  type DisplayPreferences,
  formatDateTime,
  NUMBER_PENDING_TEXT,
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
import { isAdmin } from '@/lib/server/admin';
import { appDb } from '@/lib/server/db';
import { getProfile } from '@/lib/server/profile';
import { requireTenant } from '@/lib/server/session';
import { type CopySource, NewStrategyButton } from './new-strategy';
import { RowActions } from './row-actions';
import { bare } from '@/lib/units';

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
    shared: one('shared'),
    sort: one('sort'),
    direction: one('sort') === 'name' ? 'asc' : 'desc',
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

  return (
    <>
      <PageHeader
        title="Strategy Lab"
        description="Define entry and exit rules across any mix of assets, test them, then run them on paper."
        actions={<NewStrategyButton sources={copySources} initialCopyFrom={one('copy')} />}
      />

      <form
        role="search"
        aria-label="Filter strategies"
        className="mb-4 grid-fields items-end gap-3"
      >
        <div className="sm:col-span-2">
          <TextField
            label="Search"
            name="q"
            type="search"
            defaultValue={q.q ?? ''}
            placeholder="Name, number, description or tag"
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
        <SelectField label="Origin" name="shared" defaultValue={q.shared ? '1' : ''}>
          <option value="">Any</option>
          <option value="1">Shared with me</option>
        </SelectField>
        <div className="col-span-full flex gap-2">
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
                <Th>Number</Th>
                <Th>Name</Th>
                <Th>Status</Th>
                <Th>Assets</Th>
                <Th>Version</Th>
                <Th>Account</Th>
                <Th numeric>Latest back test %</Th>
                <Th>Updated ({prefs.timeZone})</Th>
                <Th>
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.id}>
                  {/* The Strategy Library number (ADR 0054); never editable. */}
                  <Td className="whitespace-nowrap font-mono text-xs">
                    {s.libraryNumber ? (
                      <Link href={`/library/${s.libraryNumber}`}>{s.libraryNumber}</Link>
                    ) : (
                      <span className="text-ink-muted" title={NUMBER_PENDING_TEXT}>
                        —
                      </span>
                    )}
                  </Td>
                  <Td>
                    <Link href={`/strategy-lab/${s.id}`} className="font-medium">
                      {s.name}
                    </Link>
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
                  <Td className="whitespace-nowrap text-data">
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
      <span className="text-data">{bare(formatPct(run.netReturnPct, true))}</span>
      {run.finishedAt && (
        <p className="mt-0.5 whitespace-nowrap text-xs text-ink-muted">
          {formatDateTime(run.finishedAt, prefs)}
        </p>
      )}
    </>
  );
}
