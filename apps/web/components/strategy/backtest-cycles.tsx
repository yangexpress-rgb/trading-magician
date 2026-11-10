'use client';

import type {
  BacktestOrder,
  ConditionBar,
  ConditionCheck,
  PhaseConditionReport,
  RunPlan,
} from '@tm/backtest';
import type { BacktestRunDto, BacktestTradeDto } from '@tm/contracts';
import { Badge, Button, cx, SelectField, Table, Td, TextField, Th } from '@tm/ui';
import { Fragment, useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import {
  ComparisonText,
  describeMetric,
  EXIT_REASON_LABELS,
  metricText,
  Truth,
} from '@/components/strategy/backtest-detail';
import {
  comparisonEvidence,
  comparisonsOf,
  heldExits,
  CONDITION_OUTCOMES,
  describeOrder,
  describeTrigger,
  describeValues,
  explainOrder,
  ORDER_OUTCOMES,
} from '@/lib/backtest-explain';
import {
  buildCycles,
  CYCLE_STATUS,
  cycleCounts,
  cyclesCsv,
  entryKeyData,
  exitKeyData,
  matchesFilter,
  matchesSearch,
  skippedSignals,
  sortCycles,
  type CycleFilter,
  type CycleSort,
  type CycleView,
  type LegRow,
  type PhaseKeyData,
} from '@/lib/backtest-cycles';
import {
  atrStopText,
  DIRECTION_WORDS,
  expectedMoveText,
  formatMarketTime,
  formatMoney,
  formatPct,
  formatSignedMoney,
  sizingText,
} from '@/lib/backtest-text';
import { bare } from '@/lib/units';
import { SCHEDULE_LABELS, type ConditionNode, type ScheduleFrequency } from '@tm/domain';

/**
 * Back test results by cycle (N157–N165, ADR 0061): one row per cycle, and
 * opening a row shows that cycle's Entry beside its Exit, the conditions on
 * the bar that fired each, every leg's order and fill, and each leg's P/L.
 * Colours follow the strategy editor: Entry green, Exit rose, conditions
 * blue, orders amber, always beside a text label.
 */

type Interval = BacktestRunDto['inputs']['interval'];
type Result = NonNullable<BacktestRunDto['result']>;
const PAGE = 25;

const signed = (v: number | string | null) => (v === null ? '—' : bare(formatSignedMoney(v)));
const tone = (v: number | string | null) =>
  v === null ? undefined : Number(v) > 0 ? 'text-ok' : Number(v) < 0 ? 'text-danger' : undefined;

/** The cycle in the page address (`?cycle=N`), so a cycle can be bookmarked (N161). */
function cycleFromUrl(): number | null {
  if (typeof window === 'undefined') return null;
  const n = Number(new URLSearchParams(window.location.search).get('cycle'));
  return Number.isInteger(n) && n > 0 ? n : null;
}

function writeCycleToUrl(n: number | null) {
  const url = new URL(window.location.href);
  if (n === null) url.searchParams.delete('cycle');
  else url.searchParams.set('cycle', String(n));
  window.history.replaceState(window.history.state, '', url);
}

export function BacktestCycles({
  run,
  trades,
}: {
  run: BacktestRunDto;
  trades: readonly BacktestTradeDto[];
}) {
  const result = run.result as Result;
  const interval = run.inputs.interval;
  const cycles = useMemo(() => buildCycles(result, trades), [result, trades]);
  const counts = cycleCounts(cycles);
  const skipped = skippedSignals(result);
  const reasons = [
    ...new Set(
      cycles
        .map((c) => c.exitReason)
        .filter((r): r is NonNullable<CycleView['exitReason']> => r !== null && r !== undefined),
    ),
  ];

  const id = useId();
  const [filter, setFilter] = useState<CycleFilter>('all');
  const [reason, setReason] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<CycleSort>('cycle');
  const [shown, setShown] = useState(PAGE);
  const [open, setOpen] = useState<number | null>(null);

  // Open the cycle named in the address once the results are in.
  useEffect(() => {
    const n = cycleFromUrl();
    if (n === null || !cycles.some((c) => c.cycle === n)) return;
    setOpen(n);
    const index = cycles.findIndex((c) => c.cycle === n);
    setShown((s) => Math.max(s, Math.ceil((index + 1) / PAGE) * PAGE));
  }, [cycles]);

  const toggle = (n: number | null) => {
    setOpen(n);
    writeCycleToUrl(n);
  };

  const rows = sortCycles(
    cycles.filter(
      (c) =>
        matchesFilter(c, filter) &&
        matchesSearch(c, search) &&
        (reason === 'all' || c.exitReason === reason),
    ),
    sort,
  );
  const visible = rows.slice(0, shown);

  /** Steps to the previous or next cycle, clearing filters that would hide it. */
  const go = (n: number) => {
    const index = cycles.findIndex((c) => c.cycle === n);
    setFilter('all');
    setReason('all');
    setSearch('');
    setSort('cycle');
    setShown((s) => Math.max(s, Math.ceil((index + 1) / PAGE) * PAGE));
    toggle(n);
  };

  const download = () => {
    const blob = new Blob([cyclesCsv(cycles)], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cycles-and-legs-v${run.versionNo}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (cycles.length === 0) {
    return <p className="text-sm text-ink-muted">The strategy made no trades in this period.</p>;
  }

  const chip = (value: CycleFilter, label: string, n: number) => (
    <Button
      key={value}
      size="sm"
      variant={filter === value ? 'primary' : 'secondary'}
      aria-pressed={filter === value}
      onClick={() => {
        setFilter(value);
        setShown(PAGE);
      }}
    >
      {label} {n}
    </Button>
  );

  const skippedText = Object.entries(skipped)
    .map(([k, n]) => `${n} ${SKIPPED_LABELS[k] ?? k}`)
    .join(', ');

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <p className="text-sm">
          {counts.all} {counts.all === 1 ? 'cycle' : 'cycles'}: {counts.closed} closed
          {counts.unfinished > 0 ? `, ${counts.unfinished} open or not filled` : ''} · {counts.won}{' '}
          won, {counts.lost} lost · net{' '}
          <span className={cx('text-content', tone(counts.net))}>
            {formatSignedMoney(counts.net)}
          </span>
        </p>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={download}>
          Download cycles and legs (CSV)
        </Button>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div role="group" aria-label="Show cycles" className="flex flex-wrap gap-2">
          {chip('all', 'All', counts.all)}
          {chip('won', 'Won', counts.won)}
          {chip('lost', 'Lost', counts.lost)}
          {counts.unfinished > 0 && chip('unfinished', 'Open or not filled', counts.unfinished)}
        </div>
        {reasons.length > 1 && (
          <SelectField
            name={`${id}-reason`}
            label="Exit reason"
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              setShown(PAGE);
            }}
          >
            <option value="all">Any</option>
            {reasons.map((r) => (
              <option key={r} value={r}>
                {EXIT_REASON_LABELS[r]}
              </option>
            ))}
          </SelectField>
        )}
        {cycles.some((c) => c.symbols.length > 0) &&
          new Set(cycles.flatMap((c) => c.symbols)).size > 1 && (
            <TextField
              name={`${id}-search`}
              label="Instrument"
              placeholder="Symbol"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setShown(PAGE);
              }}
            />
          )}
        <SelectField
          name={`${id}-sort`}
          label="Sort"
          value={sort}
          onChange={(e) => setSort(e.target.value as CycleSort)}
        >
          <option value="cycle">Cycle number</option>
          <option value="net">Net P/L, biggest loss first</option>
          <option value="return">Return, worst first</option>
          <option value="held">Days held, longest first</option>
        </SelectField>
      </div>

      {/*
        An ARIA table of grid rows rather than a <table>, so an opened cycle card
        takes the list's width instead of the table's (O122: inline under its row).
      */}
      <div
        role="table"
        aria-label="Cycles"
        className="rounded-lg border border-line bg-surface text-sm"
      >
        <div role="rowgroup">
          <div role="row" className={cx(ROW_GRID, 'border-b border-line bg-surface-2')}>
            {HEADERS.map(([label, numeric]) => (
              <div
                key={label}
                role="columnheader"
                className={cx(
                  'px-3 py-2 text-xs font-semibold tracking-wide text-ink-muted uppercase',
                  numeric && 'sm:text-right',
                  'max-sm:sr-only',
                )}
              >
                {label}
              </div>
            ))}
          </div>
        </div>
        <div role="rowgroup">
          {visible.length === 0 && (
            <div role="row">
              <div role="cell" className="px-3 py-2 text-ink-muted">
                No cycles match.
              </div>
            </div>
          )}
          {visible.map((c) => {
            const expanded = open === c.cycle;
            const single = c.legs.length === 1 ? c.legs[0] : undefined;
            const when = (at: string | null | undefined, price: string | null | undefined) =>
              at ? (
                <>
                  {formatMarketTime(at, interval)}
                  {price && <span className="text-ink-muted"> · {formatMoney(price)}</span>}
                </>
              ) : null;
            return (
              <Fragment key={c.cycle}>
                <div
                  role="row"
                  className={cx(
                    ROW_GRID,
                    'cursor-pointer border-b border-line text-content hover:bg-surface-2',
                    expanded && 'bg-info-soft',
                  )}
                  onClick={() => toggle(expanded ? null : c.cycle)}
                >
                  <div role="cell" className={CELL}>
                    <button
                      type="button"
                      className="font-semibold whitespace-nowrap text-ink underline-offset-2 hover:underline"
                      aria-expanded={expanded}
                      aria-controls={`${id}-cycle-${c.cycle}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggle(expanded ? null : c.cycle);
                      }}
                    >
                      <span aria-hidden="true" className="mr-1 inline-block text-ink-muted">
                        {expanded ? '▾' : '▸'}
                      </span>
                      Cycle {c.cycle}
                    </button>
                    {c.status !== 'closed' && (
                      <div className="text-xs text-ink-muted">{CYCLE_STATUS[c.status].label}</div>
                    )}
                  </div>
                  <div role="cell" className={CELL}>
                    <div className="break-words">{c.symbols.join(', ')}</div>
                    <div className="text-xs text-ink-muted">
                      {DIRECTION_WORDS[c.direction]}
                      {c.trade?.group ? ` · ${c.trade.group}` : ''}
                    </div>
                  </div>
                  <div role="cell" className={CELL}>
                    <div>
                      <span className="text-xs text-ink-muted">In </span>
                      {when(c.trade?.entryTime, single?.entryPrice) ?? (
                        <span className="text-ink-muted">not filled</span>
                      )}
                    </div>
                    {c.trade?.exitTime && (
                      <div>
                        <span className="text-xs text-ink-muted">Out </span>
                        {when(c.trade.exitTime, single?.exitPrice)}
                      </div>
                    )}
                  </div>
                  <div role="cell" className={cx(CELL, 'sm:text-right')}>
                    <span className="text-xs text-ink-muted sm:hidden">Held </span>
                    {c.heldDays ?? '—'}
                    <span className="text-xs text-ink-muted sm:hidden"> days</span>
                  </div>
                  <div role="cell" className={CELL}>
                    {c.exitReason ? EXIT_REASON_LABELS[c.exitReason] : '—'}
                  </div>
                  <div role="cell" className={cx(CELL, 'sm:text-right', tone(c.net))}>
                    <span className="sr-only">Net P/L </span>
                    {signed(c.net)}
                  </div>
                  <div
                    role="cell"
                    className={cx(CELL, 'sm:text-right', tone(c.trade?.returnPct ?? null))}
                  >
                    {c.trade?.returnPct && c.status !== 'aborted'
                      ? `${bare(formatPct(c.trade.returnPct, true))}%`
                      : '—'}
                  </div>
                </div>
                {expanded && (
                  <div role="row" className="border-b border-line bg-info-soft px-2 pb-3">
                    <div role="cell">
                      <CycleCard
                        id={`${id}-cycle-${c.cycle}`}
                        c={c}
                        result={result}
                        interval={interval}
                        prev={cycles[cycles.indexOf(c) - 1]?.cycle}
                        next={cycles[cycles.indexOf(c) + 1]?.cycle}
                        go={go}
                      />
                    </div>
                  </div>
                )}
              </Fragment>
            );
          })}
        </div>
      </div>
      {rows.length > shown && (
        <Button size="sm" variant="ghost" onClick={() => setShown((n) => n + PAGE)}>
          Show more cycles ({rows.length - shown} more)
        </Button>
      )}
      <p className="text-xs text-ink-muted">
        {skippedText
          ? `Entry signals that didn't open a cycle: ${skippedText}. They're in the Entry bar log under Rules and full logs. `
          : ''}
        Times are New York market time.
      </p>
    </div>
  );
}

// The cycle list's columns: one grid row on wider screens, wrapped blocks on a phone.
const ROW_GRID =
  'flex flex-wrap gap-x-4 gap-y-1 px-1 py-1 sm:grid sm:grid-cols-[5.75rem_minmax(6.5rem,1fr)_minmax(8.5rem,1.5fr)_3rem_minmax(5rem,1fr)_5.5rem_4.5rem] sm:gap-0 sm:p-0';
const CELL = 'min-w-0 px-2 py-1 sm:px-3 sm:py-2';
const HEADERS: [string, boolean][] = [
  ['Cycle', false],
  ['Instrument', false],
  ['Entry and Exit', false],
  ['Held days', true],
  ['Exit reason', false],
  ['Net P/L $', true],
  ['Return', true],
];

const SKIPPED_LABELS: Record<string, string> = {
  cycle_open: 'while a cycle was already open',
  daily_loss: 'stopped by the daily loss limit',
  drawdown: 'stopped by the maximum drawdown',
};

// ---------------------------------------------------------------------------
// The cycle card (N158–N160)

function CycleCard({
  id,
  c,
  result,
  interval,
  prev,
  next,
  go,
}: {
  id: string;
  c: CycleView;
  result: Result;
  interval: Interval;
  prev: number | undefined;
  next: number | undefined;
  go: (n: number) => void;
}) {
  const symbol = (iid: string) => result.symbols?.[iid];
  const t = c.trade;
  return (
    <section
      id={id}
      aria-label={`Cycle ${c.cycle}`}
      className="mt-1 space-y-4 rounded-lg border border-line bg-surface p-4"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h4 className="text-base font-semibold">
          Cycle {c.cycle} · {c.symbols.join(', ')}
        </h4>
        <Badge tone={CYCLE_STATUS[c.status].tone}>{CYCLE_STATUS[c.status].label}</Badge>
        <span className="text-sm text-ink-muted">
          {DIRECTION_WORDS[c.direction]}
          {t?.group ? ` · ${t.group}` : ''}
          {c.heldDays !== null ? ` · held ${c.heldDays} ${c.heldDays === 1 ? 'day' : 'days'}` : ''}
        </span>
        {c.net !== null && (
          <span className={cx('ml-auto text-lg font-semibold text-content', tone(c.net))}>
            {formatSignedMoney(c.net)}
            {t?.returnPct ? (
              <span className="text-sm"> ({formatPct(t.returnPct, true)})</span>
            ) : null}
          </span>
        )}
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Side phase="trade" title="What to trade" className="lg:col-span-2">
          <TradeSide c={c} result={result} interval={interval} symbol={symbol} />
        </Side>
        <Side phase="entry" title={sideTitle('Entry', c.entry.decidedAt, interval)}>
          <ScheduleLine
            label="Check Entry"
            value={result.plan ? scheduleText(result.plan.entrySchedule) : null}
          />
          <EntrySignal c={c} result={result} interval={interval} symbol={symbol} />
          <KeyData
            phase="entry"
            data={entryKeyData(c, result.fills, result.plan?.perCandidate === true)}
            report={c.entry.report}
            interval={interval}
            symbol={symbol}
          />
          {t?.sizing && (
            <div className="text-xs">
              <div className="font-medium">Sized from risk % of equity</div>
              {sizingText(t.sizing).map((line) => (
                <div key={line} className="text-ink-muted">
                  {line}
                </div>
              ))}
            </div>
          )}
          <Orders
            title="Entry orders"
            orders={c.entryOrders}
            interval={interval}
            empty="No Entry orders were planned."
          />
        </Side>
        <Side phase="exit" title={sideTitle('Exit', c.exit.decidedAt, interval)}>
          <ScheduleLine
            label="Check Exit"
            value={
              result.plan
                ? result.plan.exitSchedule
                  ? scheduleText(result.plan.exitSchedule)
                  : 'Every bar the run stepped on'
                : null
            }
          />
          <ExitSignal c={c} interval={interval} symbol={symbol} />
          <KeyData
            phase="exit"
            data={exitKeyData(c, result.fills)}
            report={c.exit.report}
            interval={interval}
            symbol={symbol}
          />
          <Orders
            title="Exit orders"
            orders={c.exitOrders}
            interval={interval}
            empty={
              c.status === 'pending' || c.status === 'aborted'
                ? 'No Exit: the Entry never filled.'
                : 'No Exit orders yet: the position was still open when the test ended.'
            }
          />
        </Side>
      </div>

      <WhileOpen c={c} interval={interval} symbol={symbol} />

      {c.legs.length > 0 && <Legs c={c} />}

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={prev === undefined}
          onClick={() => prev !== undefined && go(prev)}
        >
          {prev === undefined ? '← Previous' : `← Cycle ${prev}`}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={next === undefined}
          onClick={() => next !== undefined && go(next)}
        >
          {next === undefined ? 'Next →' : `Cycle ${next} →`}
        </Button>
      </div>
    </section>
  );
}

function sideTitle(name: string, at: string | null, interval: Interval) {
  return at ? `${name} · ${formatMarketTime(at, interval)}` : name;
}

function Side({
  phase,
  title,
  className,
  children,
}: {
  phase: 'trade' | 'entry' | 'exit';
  title: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      role="group"
      aria-label={phase === 'trade' ? 'What to trade' : phase === 'entry' ? 'Entry' : 'Exit'}
      className={cx(
        'min-w-0 space-y-3 rounded-md border border-l-4 border-line p-3',
        className,
        phase === 'trade'
          ? 'border-l-ink-muted bg-surface-2'
          : phase === 'entry'
            ? 'border-l-entry bg-entry-soft'
            : 'border-l-exit bg-exit-soft',
      )}
    >
      <h5
        className={cx(
          'font-semibold',
          phase === 'trade' ? 'text-ink' : phase === 'entry' ? 'text-entry' : 'text-exit',
        )}
      >
        {title}
      </h5>
      {children}
    </div>
  );
}

const scheduleText = (f: string) => SCHEDULE_LABELS[f as ScheduleFrequency] ?? f;

/** When a part was checked (Check Entry, Check Exit; ADR 0073). */
function ScheduleLine({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="text-sm">
      <span className="text-ink-muted">{label}:</span> <span className="text-content">{value}</span>
    </div>
  );
}

/**
 * A condition as it read on one evaluation (N218): each comparison with the
 * data elements it read and their values, why it held or didn't, and the
 * records behind them; groups say whether all or any of their parts had to hold.
 */
function ConditionEvidence({
  node,
  checks,
  symbol,
}: {
  node: ConditionNode;
  checks: readonly ConditionCheck[];
  symbol: (id: string) => string | undefined;
}) {
  const byId = new Map(checks.map((x) => [x.id, x]));
  return (
    <ul className="space-y-2">
      <EvidenceNode node={node} byId={byId} symbol={symbol} />
    </ul>
  );
}

function EvidenceNode({
  node,
  byId,
  symbol,
}: {
  node: ConditionNode;
  byId: Map<string, ConditionCheck>;
  symbol: (id: string) => string | undefined;
}) {
  const check = byId.get(node.id);
  if (node.kind === 'comparison') {
    const ev = comparisonEvidence(node, check, symbol);
    return (
      <li className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <ComparisonText c={node} symbol={symbol} />
          {check && <Truth value={check.truth} />}
        </div>
        {ev.elements.length > 0 && (
          <dl className="grid grid-cols-[minmax(0,max-content)_max-content] gap-x-3 gap-y-0.5 text-xs">
            {ev.elements.map((e, i) => (
              <Fragment key={`${e.label}-${i}`}>
                <dt className={cx('text-ink-muted', e.inside && 'pl-3')}>
                  {e.inside ? '↳ ' : ''}
                  {e.label}
                  {e.at && <span> ({e.at})</span>}
                </dt>
                <dd className="text-content">{e.value}</dd>
              </Fragment>
            ))}
          </dl>
        )}
        {ev.reason && (
          <div className="text-xs">
            <span className="text-ink-muted">Why:</span>{' '}
            <span className="text-content">{ev.reason}</span>
          </div>
        )}
        {ev.sources.length > 0 && (
          <div className="text-xs">
            <span className="text-ink-muted">Data used:</span>
            <ul className="ml-3 list-disc">
              {ev.sources.map((x) => (
                <li key={x} className="text-content">
                  {x}
                </li>
              ))}
            </ul>
          </div>
        )}
      </li>
    );
  }
  const children = node.children.map((child) => (
    <EvidenceNode key={child.id} node={child} byId={byId} symbol={symbol} />
  ));
  // A plain group of one needs no heading of its own.
  if (node.children.length === 1 && !node.negate) return <>{children}</>;
  return (
    <li className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs font-semibold">
        {node.negate ? 'Must not hold: ' : ''}
        {node.op === 'and' ? 'All of these' : 'Any of these'}
        {check && <Truth value={check.truth} />}
      </div>
      <ul className="space-y-2 border-l-2 border-line pl-3">{children}</ul>
    </li>
  );
}

function SubHeading({ kind, children }: { kind: 'cond' | 'order'; children: ReactNode }) {
  return (
    <h6
      className={cx(
        'text-xs font-bold tracking-wide uppercase',
        kind === 'cond' ? 'text-cond' : 'text-order',
      )}
    >
      {children}
    </h6>
  );
}

/** One bar's checks: each condition with its data, values and why (N218). */
function BarChecks({
  report,
  bar,
  symbol,
}: {
  report: PhaseConditionReport;
  bar: ConditionBar;
  symbol: (id: string) => string | undefined;
}) {
  return <ConditionEvidence node={report.condition} checks={bar.checks} symbol={symbol} />;
}

function SignalBox({ children }: { children: ReactNode }) {
  return (
    <div className="space-y-1 rounded-md border border-l-[3px] border-line border-l-cond bg-surface p-2 text-sm">
      {children}
    </div>
  );
}

/**
 * What to trade for this cycle (N219): the specific assets, or the group with
 * this stock's filter values and its place in the ranking at the Check Entry
 * that picked it.
 */
function TradeSide({
  c,
  result,
  interval,
  symbol,
}: {
  c: CycleView;
  result: Result;
  interval: Interval;
  symbol: (id: string) => string | undefined;
}) {
  const plan = result.plan;
  const pick = c.detail?.pick;
  if (plan?.trade.kind === 'assets') {
    const n = plan.trade.symbols.length;
    return (
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
        <KeyRow label={n === 1 ? 'Asset' : 'Assets'}>{plan.trade.symbols.join(', ')}</KeyRow>
        <KeyRow label="Filter">None: specific assets are always the ones traded</KeyRow>
        {n > 1 && <KeyRow label="Together">Entered and exited together, as one position</KeyRow>}
      </dl>
    );
  }
  if (plan?.trade.kind === 'group' && pick) {
    const t = plan.trade;
    const universe =
      t.universe.type === 'builtin'
        ? (UNIVERSE_WORDS[t.universe.id] ?? t.universe.id)
        : `Your list of ${t.universe.size}`;
    return (
      <div className="space-y-3">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
          <KeyRow label="Group">{universe}</KeyRow>
          <KeyRow label="Picked">
            {pick.symbol} at the {formatMarketTime(pick.time, interval)} Check Entry
          </KeyRow>
          <KeyRow label="Members checked">{pick.members}</KeyRow>
        </dl>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="min-w-0 space-y-2">
            <SubHeading kind="cond">
              Filter{t.filter ? `: passed by ${pick.passed} of ${pick.members}` : ''}
            </SubHeading>
            {t.filter && pick.filter ? (
              <SignalBox>
                <p className="text-xs text-ink-muted">As it read for {pick.symbol}:</p>
                <ConditionEvidence node={t.filter} checks={pick.filter.checks} symbol={symbol} />
              </SignalBox>
            ) : (
              <p className="text-sm text-ink-muted">No filter: every member was a candidate.</p>
            )}
          </div>
          <div className="min-w-0 space-y-2">
            <SubHeading kind="cond">Ranking</SubHeading>
            {t.ranking ? (
              <SignalBox>
                <div className="text-xs text-ink-muted">{describeMetric(t.ranking)}</div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                  <KeyRow label={`${pick.symbol}'s value`}>
                    {metricText(t.ranking, pick.value)}
                  </KeyRow>
                  <KeyRow label="Order">
                    {t.ranking.direction === 'desc' ? 'Highest first' : 'Lowest first'}
                  </KeyRow>
                  <KeyRow label="Rank">
                    {pick.rank ?? '—'} of {pick.ranked} ranked · top {pick.count} kept
                  </KeyRow>
                </dl>
              </SignalBox>
            ) : (
              <p className="text-sm text-ink-muted">
                No ranking: candidates in symbol order, up to {pick.count}.
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }
  // Runs from before the three parts were recorded: the selection round, if any.
  const log = result.selections;
  if (c.round && log) {
    const ranked = c.round.round.rows.filter((r) => r[3] !== null).length;
    return (
      <div className="space-y-2">
        <SubHeading kind="cond">
          {log.kind === 'ranking' ? 'Selection' : 'Leg'} round of{' '}
          {formatMarketTime(c.round.round.time, interval)}
        </SubHeading>
        <SignalBox>
          {c.round.round.gate !== undefined && (
            <div className="flex flex-wrap items-center gap-2">
              Enter when (gates the whole group): <Truth value={c.round.round.gate} />
            </div>
          )}
          {c.round.rows.map(([sym, value, pass, rank, selected]) => (
            <div key={sym} className="space-y-0.5">
              <div className="font-medium">{sym}</div>
              {log.metric && (
                <div>
                  {describeMetric(log.metric)}:{' '}
                  <span className="text-content">{metricText(log.metric, value)}</span>
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                {log.kind === 'ranking' ? 'Passes the filter' : 'Leg condition holds'}:{' '}
                <Truth value={pass} />
              </div>
              {log.kind === 'ranking' && (
                <div>
                  Rank <span className="text-content">{rank ?? '—'}</span> of {ranked} ranked ·{' '}
                  {selected ? 'Selected' : 'Not selected'}
                </div>
              )}
            </div>
          ))}
          <p className="text-xs text-ink-muted">
            This run is from before each pick's filter values were recorded; run the back test again
            to see them. The whole round is under Rules and full logs, Selection rounds.
          </p>
        </SignalBox>
      </div>
    );
  }
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
      <KeyRow label={c.symbols.length === 1 ? 'Asset' : 'Assets'}>{c.symbols.join(', ')}</KeyRow>
    </dl>
  );
}

const UNIVERSE_WORDS: Record<string, string> = { sp500: 'S&P 500 (current members)' };

function EntrySignal({
  c,
  result,
  interval,
  symbol,
}: {
  c: CycleView;
  result: Result;
  interval: Interval;
  symbol: (id: string) => string | undefined;
}) {
  const { bar, report } = c.entry;
  const pick = c.detail?.pick;
  const plan: RunPlan | undefined = result.plan;
  // A group's Enter when that reads "this stock" was checked for this pick (ADR 0073).
  if (plan?.perCandidate && pick?.enterWhen && report) {
    return (
      <div className="space-y-2">
        <SubHeading kind="cond">
          Enter when, for {pick.symbol}: {formatMarketTime(pick.time, interval)} close
        </SubHeading>
        <SignalBox>
          <ConditionEvidence
            node={report.condition}
            checks={pick.enterWhen.checks}
            symbol={symbol}
          />
        </SignalBox>
      </div>
    );
  }
  if (bar && report) {
    return (
      <div className="space-y-2">
        <SubHeading kind="cond">
          Enter when{c.round ? ' (gates the whole group)' : ''}:{' '}
          {formatMarketTime(bar.time, interval)} close
        </SubHeading>
        <SignalBox>
          <BarChecks report={report} bar={bar} symbol={symbol} />
          <p className="text-xs text-ink-muted">
            {describeTrigger(report.trigger)}
            {bar.outcome ? ` · ${CONDITION_OUTCOMES[bar.outcome]}` : ''}
          </p>
        </SignalBox>
      </div>
    );
  }
  if (c.round || pick) {
    return (
      <div className="space-y-2">
        <SubHeading kind="cond">Enter when</SubHeading>
        <p className="text-sm text-ink-muted">
          No Enter when conditions: each pick of the group entered at its Check Entry.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <SubHeading kind="cond">Enter when</SubHeading>
      <p className="text-sm text-ink-muted">
        {result.conditions
          ? 'No Entry bar was recorded for this cycle: the Entry legs ran on their own timing, or the bar log was too long to keep this bar.'
          : 'This run is from before condition details were recorded.'}
      </p>
    </div>
  );
}

function ExitSignal({
  c,
  interval,
  symbol,
}: {
  c: CycleView;
  interval: Interval;
  symbol: (id: string) => string | undefined;
}) {
  const t = c.trade;
  const reason = c.exitReason;
  if (!reason) {
    return c.status === 'open' ? (
      <p className="text-sm text-ink-muted">The Exit hadn't fired when the test ended.</p>
    ) : null;
  }
  const heading = (
    <SubHeading kind="cond">
      Why it exited: {EXIT_REASON_LABELS[reason]}
      {/* Which part of Exit when sold: a trailing stop, holding period, ATR stop or expected move (N223). */}
      {reason === 'condition' && c.exit.report && c.exit.bar
        ? (() => {
            const held = heldExits(c.exit.report.condition, c.exit.bar.checks);
            return held.length > 0 ? ` (${held.join(', ')})` : '';
          })()
        : ''}
      {c.exit.decidedAt ? ` · ${formatMarketTime(c.exit.decidedAt, interval)} close` : ''}
    </SubHeading>
  );
  const ts = c.detail?.trailingStop;
  let body: ReactNode = null;
  if (reason === 'condition' && c.exit.bar && c.exit.report) {
    body = (
      <>
        <BarChecks report={c.exit.report} bar={c.exit.bar} symbol={symbol} />
        <p className="text-xs text-ink-muted">
          {c.exit.report.trigger
            ? describeTrigger(c.exit.report.trigger)
            : 'Exits on any bar it holds'}
          {c.exit.bar.outcome ? ` · ${CONDITION_OUTCOMES[c.exit.bar.outcome]}` : ''}
        </p>
      </>
    );
  } else if (reason === 'trailing_stop' && ts) {
    const short = ts.direction === 'short';
    body = (
      <>
        <div className="flex flex-wrap items-center gap-2">
          Close {short ? 'above' : 'below'} the trailing stop
          <Badge tone="danger">{short ? 'Above the stop' : 'Below the stop'}</Badge>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          <KeyRow label="Entry price">{formatMoney(ts.entryPrice)}</KeyRow>
          <KeyRow label={short ? 'Lowest close since entry' : 'Best close since entry'}>
            {formatMoney(ts.peak)}
          </KeyRow>
          <KeyRow label={`Stop level (${ts.percent}% ${short ? 'above' : 'below'})`}>
            {formatMoney(ts.level)}
          </KeyRow>
          <KeyRow label={`${formatMarketTime(ts.time, interval)} close`}>
            {formatMoney(ts.close)}
          </KeyRow>
          <KeyRow label="Closes checked">{ts.checks}</KeyRow>
        </dl>
        <div className="text-xs">
          <span className="text-ink-muted">Why:</span>{' '}
          <span className="text-content">
            {formatMoney(ts.close)} {short ? '>' : '<'} {formatMoney(ts.level)}
          </span>
        </div>
      </>
    );
  } else if (reason === 'atr_stop' && t?.atrStop) {
    body = <div className="text-content">{atrStopText(t.atrStop)}</div>;
  } else if (reason === 'expected_move' && t?.expectedMove) {
    body = <div className="text-content">{expectedMoveText(t.expectedMove)}</div>;
  } else if (reason === 'time_stop') {
    body = <div>The position reached its time limit.</div>;
  } else if (reason === 'rebalance') {
    body = <div>No longer selected at the round on this date.</div>;
  } else {
    body = <div className="text-ink-muted">No detail was recorded for this exit.</div>;
  }
  return (
    <div className="space-y-2">
      {heading}
      <SignalBox>{body}</SignalBox>
    </div>
  );
}

function Orders({
  title,
  orders,
  interval,
  empty,
}: {
  title: string;
  orders: BacktestOrder[];
  interval: Interval;
  empty: string;
}) {
  return (
    <div className="space-y-2">
      <SubHeading kind="order">{title}</SubHeading>
      {orders.length === 0 ? (
        <p className="text-sm text-ink-muted">{empty}</p>
      ) : (
        <ul aria-label={title} className="space-y-2">
          {orders.map((o, i) => {
            const outcome = ORDER_OUTCOMES[o.outcome];
            const why = explainOrder(o);
            return (
              <li
                key={`${o.legId}-${o.phase}-${i}`}
                className="space-y-0.5 rounded-md border border-l-[3px] border-line border-l-order bg-surface p-2 text-sm"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">
                    {o.phase === 'flatten' ? 'Close after a failed leg' : o.legLabel}
                  </span>
                  <span className="text-ink-muted">{describeOrder(o)}</span>
                  <Badge tone={outcome.tone}>{outcome.label}</Badge>
                </div>
                <div className="text-xs text-ink-muted">
                  {o.decidedAt ? (
                    <>
                      Decided {formatMarketTime(o.decidedAt, interval)}
                      {o.activeFrom && o.activeFrom !== o.decidedAt
                        ? ` · could fill from ${formatMarketTime(o.activeFrom, interval)}`
                        : ''}
                      {o.endedAt
                        ? ` · ${o.outcome === 'filled' ? 'filled' : 'ended'} ${formatMarketTime(o.endedAt, interval)}`
                        : ''}
                    </>
                  ) : (
                    'Not sent'
                  )}
                </div>
                {why && <div className="text-content">{why}</div>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** The Exit checks while this cycle was open, and the stops in force (N160). */
function WhileOpen({
  c,
  interval,
  symbol,
}: {
  c: CycleView;
  interval: Interval;
  symbol: (id: string) => string | undefined;
}) {
  // An empty Exit when has no checks to show: only the stops decide (N218).
  const bars =
    c.exit.report && comparisonsOf(c.exit.report.condition).length > 0 ? c.exit.bars : [];
  const t = c.trade;
  const ts = c.detail?.trailingStop;
  const stops = [
    t?.atrStop ? atrStopText(t.atrStop) : null,
    t?.expectedMove ? expectedMoveText(t.expectedMove) : null,
    ts
      ? `Trailing stop ${ts.percent}%: best close ${formatMoney(ts.peak)}, level ${formatMoney(ts.level)} at the last of ${ts.checks} ${ts.checks === 1 ? 'check' : 'checks'}`
      : null,
  ].filter((x): x is string => x !== null);
  if (bars.length === 0 && stops.length === 0) return null;
  const isTrue = bars.filter((b) => b.truth === true).length;
  const fired = bars.filter((b) => b.outcome === 'fired').length;
  const report = c.exit.report;
  return (
    <details className="rounded-md border border-dashed border-line p-3 text-sm">
      <summary className="cursor-pointer font-medium">
        While open:{' '}
        {bars.length > 0
          ? `Exit checked on ${bars.length} ${bars.length === 1 ? 'bar' : 'bars'}, true on ${isTrue}, fired ${fired === 0 ? 'never' : fired === 1 ? 'once' : `${fired} times`}`
          : 'stops in force'}
      </summary>
      <div className="mt-3 space-y-3">
        {stops.length > 0 && (
          <ul className="space-y-1">
            {stops.map((s) => (
              <li key={s} className="text-content">
                {s}
              </li>
            ))}
          </ul>
        )}
        {report?.barsTruncated && (
          <p className="text-xs text-ink-muted">
            The test had too many bars to keep them all, so some of this cycle's checks may be
            missing.
          </p>
        )}
        {bars.length > 0 && report && (
          <Table label={`Cycle ${c.cycle}: Exit checks`}>
            <thead>
              <tr>
                <Th>Bar close</Th>
                {comparisonsOf(report.condition).map((cmp, i) => (
                  <Th key={cmp.id} className="normal-case">
                    <span className="sr-only">Condition {i + 1}: </span>
                    <ComparisonText c={cmp} symbol={symbol} />
                  </Th>
                ))}
                <Th>Result</Th>
              </tr>
            </thead>
            <tbody>
              {bars.map((b) => (
                <tr key={b.time}>
                  <Td className="whitespace-nowrap">{formatMarketTime(b.time, interval)}</Td>
                  {comparisonsOf(report.condition).map((cmp) => {
                    const check = b.checks.find((x) => x.id === cmp.id);
                    return (
                      <Td key={cmp.id}>
                        <div className="flex flex-wrap items-center gap-2">
                          <span>{describeValues(cmp, check)}</span>
                          {check && <Truth value={check.truth} />}
                        </div>
                      </Td>
                    );
                  })}
                  <Td className={cx('text-ink', b.outcome === 'fired' && 'font-medium')}>
                    {b.outcome
                      ? CONDITION_OUTCOMES[b.outcome]
                      : b.truth === null
                        ? 'Not enough data to decide'
                        : 'Not met'}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </div>
    </details>
  );
}

/** Each instrument's Entry fill against its Exit fill, and its share of the P/L (N159). */
function Legs({ c }: { c: CycleView }) {
  const total = (k: 'grossPnl' | 'costs' | 'netPnl') =>
    c.legs.every((l) => l[k] !== null) ? c.legs.reduce((s, l) => s + Number(l[k]), 0) : null;
  const costs = total('costs');
  const legName = (l: LegRow) =>
    [l.entryLabels.join(' + '), l.exitLabels.join(' + ')].filter(Boolean).join(' → ');
  return (
    <Table label={`Cycle ${c.cycle}: legs`}>
      <thead>
        <tr>
          <Th>Legs</Th>
          <Th>Instrument</Th>
          <Th numeric>Qty</Th>
          <Th numeric>Entry $</Th>
          <Th numeric>Exit $</Th>
          <Th numeric>Gross P/L $</Th>
          <Th numeric>Costs $</Th>
          <Th numeric>Net P/L $</Th>
        </tr>
      </thead>
      <tbody>
        {c.legs.map((l) => (
          <tr key={l.instrumentId}>
            <Td className="min-w-36 text-ink">{legName(l)}</Td>
            <Td>{l.symbol}</Td>
            <Td numeric>{l.quantity ?? '—'}</Td>
            <Td numeric>{l.entryPrice ? bare(formatMoney(l.entryPrice)) : '—'}</Td>
            <Td numeric>{l.exitPrice ? bare(formatMoney(l.exitPrice)) : '—'}</Td>
            <Td numeric className={tone(l.grossPnl)}>
              {signed(l.grossPnl)}
            </Td>
            <Td numeric>{l.costs === null ? '—' : bare(formatMoney(l.costs))}</Td>
            <Td numeric className={tone(l.netPnl)}>
              {signed(l.netPnl)}
            </Td>
          </tr>
        ))}
        {c.legs.length > 1 && (
          <tr>
            <Td className="font-semibold text-ink">Cycle total</Td>
            <Td />
            <Td />
            <Td />
            <Td />
            <Td numeric className={tone(total('grossPnl'))}>
              {signed(total('grossPnl'))}
            </Td>
            <Td numeric>{costs === null ? '—' : bare(formatMoney(costs))}</Td>
            <Td numeric className={cx('font-semibold', tone(total('netPnl')))}>
              {signed(total('netPnl'))}
            </Td>
          </tr>
        )}
      </tbody>
    </Table>
  );
}

// ---------------------------------------------------------------------------
// Key data for each side (N169): conditions, timing and execution at a glance

/** A fill against the last close: "0.36% worse", "0.51% better" or "at the close". */
const costText = (pct: number) =>
  pct === 0 ? 'at the close' : `${Math.abs(pct).toFixed(2)}% ${pct > 0 ? 'worse' : 'better'}`;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function KeyRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-ink-muted">{label}</dt>
      <dd className="text-content">{children}</dd>
    </>
  );
}

function KeyData({
  phase,
  data,
  report,
  interval,
  symbol,
}: {
  phase: 'entry' | 'exit';
  data: PhaseKeyData;
  report: PhaseConditionReport | null;
  interval: Interval;
  symbol: (id: string) => string | undefined;
}) {
  const name = phase === 'entry' ? 'Entry' : 'Exit';
  const { conditions: k, timing: t, execution } = data;
  const at = (v: string | null) => (v ? formatMarketTime(v, interval) : '—');
  const window =
    phase === 'entry'
      ? k?.since
        ? `Since the previous Entry signal (${at(k.since)})`
        : 'Since the start of the test'
      : 'While the position was open';
  return (
    <section aria-label={`${name} key data`} className="space-y-2">
      <SubHeading kind="cond">Key data</SubHeading>
      <div className="space-y-3 rounded-md border border-line bg-surface p-2 text-sm">
        {k && (
          <div className="space-y-1">
            <h6 className="text-xs font-semibold text-ink-muted">Conditions</h6>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
              <KeyRow label="Window">{window}</KeyRow>
              <KeyRow label="Checked">
                {plural(k.checked, 'bar')}: true on {k.trueBars}, false on{' '}
                {k.checked - k.trueBars - k.unknownBars}
                {k.unknownBars > 0 ? `, no data on ${k.unknownBars}` : ''}
              </KeyRow>
              <KeyRow label="First true">{at(k.firstTrue)}</KeyRow>
              <KeyRow label="Fired">{k.firedAt ? at(k.firedAt) : 'Not by its condition'}</KeyRow>
            </dl>
            {report && k.bars.length > 0 && (
              <details>
                <summary className="cursor-pointer text-xs font-medium">
                  {phase === 'entry'
                    ? `Bars up to the signal (${k.bars.length > 10 ? 'last 10 of ' : ''}${k.bars.length})`
                    : `Bars up to the Exit (${k.bars.length > 10 ? 'last 10 of ' : ''}${k.bars.length})`}
                </summary>
                <ul className="mt-2 space-y-2">
                  {k.bars.slice(-10).map((b) => (
                    <li key={b.time} className="border-t border-line pt-1">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-medium text-ink">{at(b.time)}</span>
                        <Truth value={b.truth} />
                        {b.outcome && (
                          <span className="text-ink-muted">{CONDITION_OUTCOMES[b.outcome]}</span>
                        )}
                      </div>
                      <BarValues report={report} bar={b} symbol={symbol} />
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
        <div className="space-y-1">
          <h6 className="text-xs font-semibold text-ink-muted">Timing</h6>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            <KeyRow label="Signal">{t.signalAt ? `${at(t.signalAt)} close` : '—'}</KeyRow>
            <KeyRow label="Could fill from">{at(t.activeFrom)}</KeyRow>
            <KeyRow label="Filled">
              {t.filledAt ? at(t.filledAt) : 'Not filled'}
              {t.daysToFill !== null
                ? ` (${plural(t.daysToFill, 'day')} after the signal${t.barsWorking > 0 ? `, ${plural(t.barsWorking, 'bar')} working` : ''})`
                : ''}
            </KeyRow>
          </dl>
        </div>
        {execution.length > 0 && (
          <div className="space-y-1">
            <h6 className="text-xs font-semibold text-ink-muted">Execution</h6>
            <ul className="space-y-1">
              {execution.map((e, i) => (
                <li key={`${e.label}-${i}`}>
                  <span className="font-medium text-ink">{e.label}</span>{' '}
                  <span className="text-content">
                    {e.reference ? `last close ${formatMoney(e.reference)}` : 'no reference close'}
                    {e.fillPrice
                      ? ` → filled ${e.filled} at ${formatMoney(e.fillPrice)}`
                      : ' → not filled'}
                    {e.costPct !== null ? ` (${costText(Number(e.costPct))})` : ''}
                  </span>
                  <div className="text-xs text-ink-muted">
                    Slippage {formatMoney(e.slippage)} · commission {formatMoney(e.commission)}
                    {e.bestPrice ? ` · best price while working ${formatMoney(e.bestPrice)}` : ''}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}

/** One bar's condition values, compactly. */
function BarValues({
  report,
  bar,
  symbol,
}: {
  report: PhaseConditionReport;
  bar: ConditionBar;
  symbol: (id: string) => string | undefined;
}) {
  return (
    <ul className="text-xs">
      {comparisonsOf(report.condition).map((cmp) => {
        const check = bar.checks.find((x) => x.id === cmp.id);
        return (
          <li key={cmp.id} className="flex flex-wrap items-center gap-1">
            <span className="text-ink-muted">
              <ComparisonText c={cmp} symbol={symbol} />:
            </span>
            <span className="text-content">{describeValues(cmp, check)}</span>
            {check && comparisonsOf(report.condition).length > 1 && <Truth value={check.truth} />}
          </li>
        );
      })}
    </ul>
  );
}
