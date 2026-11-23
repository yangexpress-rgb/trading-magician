'use client';

import type { RunDetailKindDto, RuntimeSummaryDto } from '@tm/contracts';
import { Badge, Button, cx, Table, Td, Th } from '@tm/ui';
import Link from 'next/link';
import { AccountLabel } from '@/components/accounts/account-label';
import type { ReactNode } from 'react';
import { HeaderFilter, type HeaderFilterDef } from '@/components/filters/header-filter';
import { formatPct, formatSignedMoney } from '@/lib/backtest-text';
import { RUNTIME_STATUS } from '@/lib/order-text';
import {
  countRuntimeFilters,
  emptyRuntimeFilters,
  matchesRuntime,
  parseBound,
  PERIODS,
  winRate,
  type RangeKey,
  type RuntimeListFilters,
} from '@/lib/runtime-list';
import { signTone } from '@/lib/sign-tone';
import type { RunDetailRequest } from './run-detail';

const PERIOD_OPTIONS = [
  { value: '', label: 'Any time' },
  ...PERIODS.map((p) => ({ value: p.value, label: p.label })),
];

const badBound = (t: string) => parseBound(t) === null;

/**
 * Strategies on paper as a list (N304): one row per run with its key figures.
 * Every column header sorts the rows (N303) and has a funnel that filters them.
 */
export function RuntimeList({
  runtimes,
  highlight,
  when,
  onShow,
  onDetail,
  filters,
  onFilters,
  todaySession,
}: {
  runtimes: RuntimeSummaryDto[];
  highlight: string | undefined;
  when: (iso: string) => string;
  onShow: (runtimeId: string) => void;
  /** A figure was double-clicked: list the orders it counts (N305). */
  onDetail: (request: RunDetailRequest) => void;
  filters: RuntimeListFilters;
  onFilters: (f: RuntimeListFilters) => void;
  /** The NYSE session "today" means (N326), as a New York date. */
  todaySession: string;
}) {
  const sessionText = sessionLabel(todaySession);
  const shown = runtimes.filter((r) => matchesRuntime(r, filters));
  const set = countRuntimeFilters(filters);
  const patch = (p: Partial<RuntimeListFilters>) => onFilters({ ...filters, ...p });
  const setRange = (key: RangeKey, end: 'min' | 'max', text: string) =>
    patch({ ranges: { ...filters.ranges, [key]: { ...filters.ranges[key], [end]: text } } });

  const range = (key: RangeKey, label: string, hint?: string) => {
    const def: HeaderFilterDef = {
      kind: 'range',
      key,
      label,
      min: filters.ranges[key].min,
      max: filters.ranges[key].max,
      invalid: badBound,
      ...(hint ? { hint } : {}),
    };
    return (
      <HeaderFilter
        filter={def}
        onRange={(end, text) => setRange(key, end, text)}
        onClear={() => patch({ ranges: { ...filters.ranges, [key]: { min: '', max: '' } } })}
      />
    );
  };

  return (
    <div>
      {set > 0 && (
        <p className="mb-2 flex flex-wrap items-center gap-2 text-sm text-ink-muted" role="status">
          Showing {shown.length} of {runtimes.length}.
          <Button size="sm" variant="ghost" onClick={() => onFilters(emptyRuntimeFilters())}>
            Clear filters ({set})
          </Button>
        </p>
      )}
      <Table label="Strategies on paper">
        <thead>
          <tr>
            <Th
              filter={
                <HeaderFilter
                  filter={{
                    kind: 'text',
                    key: 'number',
                    label: 'Number',
                    value: filters.number,
                    placeholder: 'S00041',
                  }}
                  onText={(number) => patch({ number })}
                  onClear={() => patch({ number: '' })}
                />
              }
            >
              Number
            </Th>
            <Th
              filter={
                <HeaderFilter
                  filter={{
                    kind: 'text',
                    key: 'strategy',
                    label: 'Strategy',
                    value: filters.strategy,
                    placeholder: 'VIX',
                  }}
                  onText={(strategy) => patch({ strategy })}
                  onClear={() => patch({ strategy: '' })}
                />
              }
            >
              Strategy
            </Th>
            <Th>Account</Th>
            <Th
              filter={
                <HeaderFilter
                  filter={{
                    kind: 'choice',
                    key: 'status',
                    label: 'Status',
                    value: filters.status,
                    options: [
                      { value: '', label: 'Any status' },
                      { value: 'running', label: 'Running' },
                      { value: 'paused', label: 'Paused' },
                      { value: 'stopped', label: 'Stopped' },
                    ],
                  }}
                  onChoice={(v) => patch({ status: v as RuntimeListFilters['status'] })}
                  onClear={() => patch({ status: '' })}
                />
              }
            >
              Status
            </Th>
            <Th
              filter={
                <HeaderFilter
                  filter={{
                    kind: 'choice',
                    key: 'started',
                    label: 'Started',
                    value: filters.started,
                    options: PERIOD_OPTIONS,
                  }}
                  onChoice={(v) => patch({ started: v as RuntimeListFilters['started'] })}
                  onClear={() => patch({ started: '' })}
                />
              }
            >
              Started
            </Th>
            <Th
              filter={
                <HeaderFilter
                  filter={{
                    kind: 'choice',
                    key: 'lastEntry',
                    label: 'Last entry',
                    value: filters.lastEntry,
                    options: [...PERIOD_OPTIONS, { value: 'none', label: 'No entry yet' }],
                  }}
                  onChoice={(v) => patch({ lastEntry: v as RuntimeListFilters['lastEntry'] })}
                  onClear={() => patch({ lastEntry: '' })}
                />
              }
            >
              Last entry
            </Th>
            <Th numeric filter={range('completedToday', 'Completed today')}>
              <span
                title={`Cycles that completed in the ${sessionText} session. Click a figure to list them with their orders.`}
              >
                Completed today
              </span>
            </Th>
            <Th
              numeric
              filter={range('todayPnl', "Today's return", 'In dollars, such as -50 or 200.')}
            >
              <span
                title={`Realized plus unrealized P/L over the ${sessionText} session, in dollars and as a % of the capital at work that session.`}
              >
                Today&apos;s return
              </span>
            </Th>
            <Th numeric filter={range('completed', 'Completed')}>
              Completed
            </Th>
            <Th numeric filter={range('active', 'Active')}>
              Active
            </Th>
            <Th numeric filter={range('rejected', 'Rejected')}>
              Rejected
            </Th>
            <Th numeric filter={range('entering', 'Entering')}>
              Entering
            </Th>
            <Th numeric filter={range('pnl', 'Realized P/L', 'In dollars, such as -50 or 200.')}>
              Realized P/L
            </Th>
            <Th numeric filter={range('winRate', 'Win rate', 'In percent, such as 50.')}>
              Win rate
            </Th>
            <Th>
              <span className="sr-only">Actions</span>
            </Th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => {
            const s = RUNTIME_STATUS[r.status];
            const isNew = highlight === r.strategyId && r.status !== 'stopped';
            const rate = winRate(r);
            const detail = (kind: RunDetailKindDto, column: string) => () =>
              onDetail({ runtime: r, kind, column });
            const href = r.strategyId ? `/strategy-lab/${r.strategyId}` : undefined;
            return (
              <tr key={r.id} className={cx(isNew && 'bg-info-soft')}>
                <Td className="font-mono text-xs whitespace-nowrap">{r.strategyNumber ?? '—'}</Td>
                <Td className="min-w-[10rem]">
                  {href ? (
                    <Link href={href} className="font-semibold underline">
                      {r.strategyName}
                    </Link>
                  ) : (
                    <span className="font-semibold">{r.strategyName}</span>
                  )}
                </Td>
                <Td sortValue={r.accountName} className="text-xs">
                  <AccountLabel name={r.accountName} mode={r.accountMode} />
                </Td>
                <Td sortValue={s.label}>
                  <span className="flex flex-wrap items-center gap-1">
                    <Badge tone={s.tone}>{s.label}</Badge>
                    {isNew && <Badge tone="info">Just started</Badge>}
                  </span>
                  {r.status === 'paused' && r.pauseReason && (
                    <span
                      className="mt-0.5 block max-w-[7rem] truncate text-xs text-ink-muted"
                      title={r.pauseReason}
                    >
                      {r.pauseReason}
                    </span>
                  )}
                  {r.status !== 'stopped' && r.fallbackFeed && (
                    <span className="mt-0.5 block text-xs text-warn">
                      Now pricing from the fallback feed {r.fallbackFeed}
                    </span>
                  )}
                </Td>
                <Td>
                  <When iso={r.startedAt} text={when(r.startedAt)} />
                </Td>
                <Td>
                  {r.lastEntryAt ? (
                    <When iso={r.lastEntryAt} text={when(r.lastEntryAt)} />
                  ) : (
                    <span className="text-ink-muted">None yet</span>
                  )}
                </Td>
                <Td
                  numeric
                  sortValue={r.completedToday}
                  className={cx(
                    'font-semibold tabular-nums',
                    r.completedToday > 0 ? 'text-ok' : 'text-ink-muted',
                  )}
                >
                  <Figure
                    label={`${r.completedToday} completed today`}
                    onOpen={detail('completed_today', 'Completed today')}
                    click
                  >
                    {r.completedToday}
                  </Figure>
                </Td>
                <TodayReturn today={r.today} open={detail('today', "Today's return")} />
                <Count
                  n={r.cycles.completed}
                  tone="text-ok"
                  open={detail('completed', 'Completed')}
                />
                <Count n={r.cycles.active} tone="text-info" open={detail('active', 'Active')} />
                <Count
                  n={r.cycles.rejected}
                  tone="text-danger"
                  open={detail('rejected', 'Rejected')}
                />
                <Count
                  n={r.cycles.entering}
                  tone="text-warn"
                  open={detail('entering', 'Entering')}
                />
                <Td numeric sortValue={Number(r.realizedPnl)} className="tabular-nums">
                  <Figure
                    label={`Realized P/L ${formatSignedMoney(r.realizedPnl)}`}
                    onOpen={detail('completed', 'Realized P/L')}
                  >
                    <span className={signTone(r.realizedPnl)}>
                      {formatSignedMoney(r.realizedPnl)}
                    </span>
                  </Figure>
                </Td>
                <Td numeric sortValue={rate ?? ''} className="tabular-nums">
                  {rate === null ? (
                    <span className="text-ink-muted">—</span>
                  ) : (
                    <Figure
                      label={`Win rate ${rate.toFixed(0)}%`}
                      onOpen={detail('completed', 'Win rate')}
                    >
                      {formatPct(rate.toFixed(0))}
                    </Figure>
                  )}
                </Td>
                <Td className="whitespace-nowrap">
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Show the orders of ${r.strategyNumber ? `${r.strategyNumber} ` : ''}${r.strategyName}`}
                    onClick={() => onShow(r.id)}
                  >
                    Orders
                  </Button>
                </Td>
              </tr>
            );
          })}
          {shown.length === 0 && (
            <tr>
              <td colSpan={15} className="px-3 py-4 text-sm text-ink-muted">
                No strategy on paper matches these filters.
              </td>
            </tr>
          )}
        </tbody>
      </Table>
    </div>
  );
}

/**
 * A date and time that may break between the two, never inside either, so a
 * narrow window shows "Nov 19," over "8:37 AM" instead of scrolling sideways.
 */
function When({ iso, text }: { iso: string; text: string }) {
  const m = /^(.*?,)\s(.*)$/.exec(text);
  return (
    <time dateTime={iso}>
      {m ? (
        <>
          <span className="whitespace-nowrap">{m[1]}</span>{' '}
          <span className="whitespace-nowrap">{m[2]}</span>
        </>
      ) : (
        text
      )}
    </time>
  );
}

/** A cycle count in its outcome's colour; a zero stays grey (N281). */
function Count({ n, tone, open }: { n: number; tone: string; open: () => void }) {
  return (
    <Td
      numeric
      sortValue={n}
      className={cx('font-semibold tabular-nums', n > 0 ? tone : 'text-ink-muted')}
    >
      <Figure label={String(n)} onOpen={open}>
        {n}
      </Figure>
    </Td>
  );
}

/**
 * A figure that lists what it counts when double-clicked (N305), or with Enter
 * when it has focus.
 */
function Figure({
  children,
  label,
  onOpen,
  click = false,
}: {
  children: ReactNode;
  label: string;
  onOpen: () => void;
  /** Opens on a single click too, for figures meant to be looked into (N326). */
  click?: boolean;
}) {
  return (
    <span
      role="button"
      tabIndex={0}
      aria-label={`${label}: list the orders`}
      title={
        click ? 'Click to list these cycles and their orders' : 'Double-click to list these orders'
      }
      onClick={click ? onOpen : undefined}
      onDoubleClick={(e) => {
        e.preventDefault();
        window.getSelection()?.removeAllRanges();
        if (!click) onOpen();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className="cursor-pointer rounded px-0.5 select-none hover:bg-surface-2 hover:underline hover:decoration-dotted"
    >
      {children}
    </span>
  );
}

/** "Nov 21" for a New York session date, the session Today figures measure. */
function sessionLabel(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  return Number.isNaN(d.getTime())
    ? date
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/**
 * Today's return (N327): realized plus unrealized over today's session, in
 * dollars over its %; hovering shows the two parts. Double-click lists the
 * cycles behind it.
 */
function TodayReturn({ today, open }: { today: RuntimeSummaryDto['today']; open: () => void }) {
  const parts = `Realized ${formatSignedMoney(today.realized)}, unrealized ${formatSignedMoney(today.unrealized)}`;
  return (
    <Td numeric sortValue={Number(today.pnl)} className="tabular-nums">
      <span title={parts}>
        <Figure label={`Today's return ${formatSignedMoney(today.pnl)}`} onOpen={open}>
          <span className={cx('font-semibold', signTone(today.pnl))}>
            {formatSignedMoney(today.pnl)}
          </span>
        </Figure>
        <span
          className={cx(
            'block text-xs',
            today.pct === null ? 'text-ink-muted' : signTone(today.pct),
          )}
        >
          {today.pct === null ? '—' : formatPct(today.pct, true)}
        </span>
      </span>
    </Td>
  );
}
