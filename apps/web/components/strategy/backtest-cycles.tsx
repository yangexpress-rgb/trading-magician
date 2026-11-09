'use client';

import type { BacktestOrder, ConditionBar, PhaseConditionReport } from '@tm/backtest';
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
  comparisonsOf,
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
  matchesFilter,
  matchesSearch,
  skippedSignals,
  sortCycles,
  type CycleFilter,
  type CycleSort,
  type CycleView,
  type LegRow,
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
        <Side phase="entry" title={sideTitle('Entry', c.entry.decidedAt, interval)}>
          <EntrySignal c={c} result={result} interval={interval} symbol={symbol} />
          {t?.sizing && (
            <div className="text-xs">
              <div className="font-medium">Risk % of equity, ATR stop</div>
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
          <ExitSignal c={c} interval={interval} symbol={symbol} />
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
  children,
}: {
  phase: 'entry' | 'exit';
  title: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cx(
        'min-w-0 space-y-3 rounded-md border border-l-4 border-line p-3',
        phase === 'entry' ? 'border-l-entry bg-entry-soft' : 'border-l-exit bg-exit-soft',
      )}
    >
      <h5 className={cx('font-semibold', phase === 'entry' ? 'text-entry' : 'text-exit')}>
        {title}
      </h5>
      {children}
    </div>
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

/** One bar's checks: each condition with its values and True or False. */
function BarChecks({
  report,
  bar,
  symbol,
}: {
  report: PhaseConditionReport;
  bar: ConditionBar;
  symbol: (id: string) => string | undefined;
}) {
  const comparisons = comparisonsOf(report.condition);
  return (
    <ul className="space-y-1">
      {comparisons.map((cmp) => {
        const check = bar.checks.find((x) => x.id === cmp.id);
        return (
          <li key={cmp.id}>
            <div>
              <ComparisonText c={cmp} symbol={symbol} />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-content">{describeValues(cmp, check)}</span>
              {check && <Truth value={check.truth} />}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function SignalBox({ children }: { children: ReactNode }) {
  return (
    <div className="space-y-1 rounded-md border border-l-[3px] border-line border-l-cond bg-surface p-2 text-sm">
      {children}
    </div>
  );
}

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
  const log = result.selections;
  const ranked = c.round?.round.rows.filter((r) => r[3] !== null).length ?? 0;
  return (
    <div className="space-y-2">
      {c.round && log ? (
        <>
          <SubHeading kind="cond">
            Signal: {log.kind === 'ranking' ? 'selection' : 'leg'} round of{' '}
            {formatMarketTime(c.round.round.time, interval)}
          </SubHeading>
          <SignalBox>
            {c.round.round.gate !== undefined && (
              <div className="flex flex-wrap items-center gap-2">
                Entry condition (gates the whole selection): <Truth value={c.round.round.gate} />
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
                  {log.kind === 'ranking' ? 'Passes the pre-filter' : 'Leg condition holds'}:{' '}
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
              The whole round is under Rules and full logs, Selection rounds.
            </p>
          </SignalBox>
        </>
      ) : bar && report ? (
        <>
          <SubHeading kind="cond">Signal: {formatMarketTime(bar.time, interval)} close</SubHeading>
          <SignalBox>
            <BarChecks report={report} bar={bar} symbol={symbol} />
            <p className="text-xs text-ink-muted">
              {describeTrigger(report.trigger)}
              {bar.outcome ? ` · ${CONDITION_OUTCOMES[bar.outcome]}` : ''}
            </p>
          </SignalBox>
        </>
      ) : (
        <>
          <SubHeading kind="cond">Signal</SubHeading>
          <p className="text-sm text-ink-muted">
            {result.conditions
              ? 'No Entry bar was recorded for this cycle: the Entry legs ran on their own timing, or the bar log was too long to keep this bar.'
              : 'This run is from before condition details were recorded.'}
          </p>
        </>
      )}
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
      Signal: {EXIT_REASON_LABELS[reason]}
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
    body = (
      <>
        <div>
          Best close since entry: <span className="text-content">{formatMoney(ts.peak)}</span>
        </div>
        <div>
          Stop level {ts.percent}% {ts.direction === 'short' ? 'above' : 'below'}:{' '}
          <span className="text-content">{formatMoney(ts.level)}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {formatMarketTime(ts.time, interval)} close:{' '}
          <span className="text-content">{formatMoney(ts.close)}</span>
          <Badge tone="danger">
            {ts.direction === 'short' ? 'Above the stop' : 'Below the stop'}
          </Badge>
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
  const bars = c.exit.bars;
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
            <Td className="text-ink">{legName(l)}</Td>
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
