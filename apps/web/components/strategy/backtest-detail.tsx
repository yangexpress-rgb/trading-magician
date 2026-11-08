'use client';

import type {
  BacktestOrder,
  PhaseConditionReport,
  SelectionLog,
  SelectionRound,
  StoredTruth,
} from '@tm/backtest';
import type { BacktestRunDto, BacktestTradeDto } from '@tm/contracts';
import { getMetric, SCHEDULE_LABELS, type Comparison, type ScheduleFrequency } from '@tm/domain';
import { Badge, Button, Card, cx, SelectField, Table, Td, Th } from '@tm/ui';
import { useId, useState } from 'react';
import {
  comparisonsOf,
  CONDITION_OUTCOMES,
  describeOrder,
  describeTrigger,
  describeValues,
  explainOrder,
  ORDER_OUTCOMES,
  summarizeConditions,
  truthOf,
} from '@/lib/backtest-explain';
import { formatMarketTime } from '@/lib/backtest-text';
import { describeCondition, describeExpr, OPERATOR_LABELS } from '@/lib/strategy-text';

/**
 * What the Entry and Exit of a back test did (Design v1.0 §7.3): the data each
 * condition saw and whether it held on each bar, and every planned order with
 * whether it filled and why. Colours follow the strategy editor: Entry green,
 * Exit rose, conditions blue, orders amber, always beside a text label.
 */

const PAGE = 50;
type Interval = BacktestRunDto['inputs']['interval'];

function Truth({ value }: { value: StoredTruth }) {
  const t = truthOf(value);
  return <Badge tone={t.tone}>{t.label}</Badge>;
}

export function PhaseReports({ run }: { run: BacktestRunDto }) {
  const result = run.result;
  if (!result) return null;
  const { conditions, orders } = result;
  if (!conditions || !orders) {
    return (
      <p className="text-sm text-ink-muted">
        This run is from before condition and order details were recorded. Run the back test again
        to see what each condition found and why each order did or didn&apos;t fill.
      </p>
    );
  }
  const symbols = result.symbols ?? {};
  const symbol = (id: string) => symbols[id];
  // Entry groups (v1.2 item 8): each group's conditions and its own orders.
  const groups = result.groupConditions ?? [];
  const otherLegs = new Set(groups.flatMap((g) => g.legIds));
  const parts = [
    {
      key: 'own',
      title: groups.length > 0 ? 'Group 1' : undefined,
      conditions,
      orders: orders.filter((o) => !otherLegs.has(o.legId)),
    },
    ...groups.map((g) => {
      const legs = new Set(g.legIds);
      return {
        key: g.id,
        title: `${g.label} (${g.direction === 'short' ? 'Short' : 'Long'})`,
        conditions: { entry: g.entry, exit: g.exit },
        orders: orders.filter((o) => legs.has(o.legId)),
      };
    }),
  ];
  return (
    <div className="space-y-6">
      {parts.flatMap((part) =>
        (['entry', 'exit'] as const).map((phase) => (
          <PhaseReport
            key={`${part.key}-${phase}`}
            phase={phase}
            groupTitle={part.title}
            report={part.conditions[phase]}
            orders={part.orders.filter((o) =>
              phase === 'entry' ? o.phase === 'entry' : o.phase !== 'entry',
            )}
            symbol={symbol}
            interval={run.inputs.interval}
            slots={!!result.selections}
          />
        )),
      )}
    </div>
  );
}

function PhaseReport({
  phase,
  groupTitle,
  report,
  orders,
  symbol,
  interval,
  slots,
}: {
  phase: 'entry' | 'exit';
  /** Set when the strategy has several entry groups (v1.2 item 8). */
  groupTitle?: string | undefined;
  report: PhaseConditionReport;
  orders: BacktestOrder[];
  symbol: (id: string) => string | undefined;
  interval: Interval;
  slots: boolean;
}) {
  const id = useId();
  const title = phase === 'entry' ? 'Entry' : 'Exit';
  const heading = groupTitle ? `${title}: ${groupTitle}` : title;
  return (
    <Card
      aria-labelledby={id}
      className={cx(
        'border-l-4',
        phase === 'entry' ? 'border-l-entry bg-entry-soft!' : 'border-l-exit bg-exit-soft!',
      )}
    >
      <h3
        id={id}
        className={cx('text-lg font-semibold', phase === 'entry' ? 'text-entry' : 'text-exit')}
      >
        {heading}
      </h3>
      <p className="mb-4 text-sm">
        {slots && phase === 'entry' && report.evaluated === 0
          ? 'There are no strategy-level Entry conditions: every scheduled evaluation ranked or checked the instruments on its own. See the rounds below.'
          : summarizeConditions(phase, report)}
      </p>
      <ConditionReport
        title={groupTitle ? `${title} conditions: ${groupTitle}` : `${title} conditions`}
        report={report}
        symbol={symbol}
        interval={interval}
        showCycle={phase === 'exit'}
      />
      <OrderReport
        title={groupTitle ? `${title} orders: ${groupTitle}` : `${title} orders`}
        phase={phase}
        orders={orders}
        report={report}
        interval={interval}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Conditions

function ConditionReport({
  title,
  report,
  symbol,
  interval,
  showCycle,
}: {
  title: string;
  report: PhaseConditionReport;
  symbol: (id: string) => string | undefined;
  interval: Interval;
  showCycle: boolean;
}) {
  const comparisons = comparisonsOf(report.condition);
  const summaries = new Map(report.comparisons.map((s) => [s.id, s]));
  const latest = report.bars.at(-1);
  const joiner = report.condition.kind === 'group' && report.condition.op === 'or' ? 'any' : 'all';
  return (
    <section aria-label={title} className="space-y-3">
      <h4 className="text-base font-semibold text-cond">{title}</h4>
      <div className="rounded-md border border-l-4 border-line border-l-cond bg-surface p-3 text-sm">
        <p className="font-medium">{describeCondition(report.condition, symbol)}</p>
        <p className="text-ink-muted">
          {comparisons.length > 1 ? `Qualifies when ${joiner} of these hold. ` : ''}
          {describeTrigger(report.trigger)}.
        </p>
      </div>
      {comparisons.length > 0 && (
        <Table label={`${title}: each condition`}>
          <thead>
            <tr>
              <Th>Condition</Th>
              <Th numeric>True on</Th>
              <Th numeric>False on</Th>
              <Th numeric>No data on</Th>
              <Th>First true</Th>
              <Th>Last check</Th>
            </tr>
          </thead>
          <tbody>
            {comparisons.map((c) => {
              const s = summaries.get(c.id);
              const check = latest?.checks.find((x) => x.id === c.id);
              return (
                <tr key={c.id}>
                  <Td>
                    <ComparisonText c={c} symbol={symbol} />
                  </Td>
                  <Td numeric>{s ? s.trueBars : '—'}</Td>
                  <Td numeric>{s ? s.falseBars : '—'}</Td>
                  <Td numeric>{s ? s.unknownBars : '—'}</Td>
                  <Td className="whitespace-nowrap text-data">
                    {formatMarketTime(s?.firstTrue ?? null, interval)}
                  </Td>
                  <Td>
                    {check ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-data">{describeValues(c, check)}</span>
                        <Truth value={check.truth} />
                      </div>
                    ) : (
                      '—'
                    )}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
      {report.bars.length > 0 && (
        <BarLog
          title={title}
          report={report}
          comparisons={comparisons}
          symbol={symbol}
          interval={interval}
          showCycle={showCycle}
        />
      )}
    </section>
  );
}

function ComparisonText({
  c,
  symbol,
}: {
  c: Comparison;
  symbol: (id: string) => string | undefined;
}) {
  const right = c.right ? describeExpr(c.right, symbol) : '';
  const upper = c.upper ? ` and ${describeExpr(c.upper, symbol)}` : '';
  return (
    <span>
      {describeExpr(c.left, symbol)}{' '}
      <span className="text-ink-muted">{OPERATOR_LABELS[c.operator]}</span> {right}
      {upper}
    </span>
  );
}

type BarFilter = 'all' | 'true' | 'fired';

function BarLog({
  title,
  report,
  comparisons,
  symbol,
  interval,
  showCycle,
}: {
  title: string;
  report: PhaseConditionReport;
  comparisons: Comparison[];
  symbol: (id: string) => string | undefined;
  interval: Interval;
  showCycle: boolean;
}) {
  const [filter, setFilter] = useState<BarFilter>('all');
  const [shown, setShown] = useState(PAGE);
  const rows = report.bars.filter((b) =>
    filter === 'all'
      ? true
      : filter === 'true'
        ? b.truth === true
        : b.outcome === 'fired' || b.outcome === 'cycle_open',
  );
  // Newest first: the end of the test is usually what needs explaining.
  const visible = rows.slice(-shown).reverse();
  return (
    <details className="rounded-md border border-line bg-surface p-3">
      <summary className="cursor-pointer text-sm font-medium">
        Bar by bar ({report.bars.length} {report.bars.length === 1 ? 'bar' : 'bars'})
      </summary>
      <div className="mt-3 space-y-3">
        <div className="grid-fields">
          <SelectField
            name={`${title}-filter`}
            label="Show"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value as BarFilter);
              setShown(PAGE);
            }}
          >
            <option value="all">Every bar</option>
            <option value="true">Bars where the conditions were true</option>
            <option value="fired">Bars where the trigger fired</option>
          </SelectField>
        </div>
        {report.barsTruncated && (
          <p className="text-xs text-ink-muted">
            The test had too many bars to keep them all: this list keeps the bars where the
            conditions were true, fired or changed.
          </p>
        )}
        {visible.length === 0 ? (
          <p className="text-sm text-ink-muted">No bars match.</p>
        ) : (
          <Table label={`${title}: bar by bar`}>
            <thead>
              <tr>
                <Th>Bar close</Th>
                {showCycle && <Th>Cycle</Th>}
                {comparisons.map((c, i) => (
                  <Th key={c.id} className="normal-case">
                    <span className="sr-only">Condition {i + 1}: </span>
                    <ComparisonText c={c} symbol={symbol} />
                  </Th>
                ))}
                {comparisons.length > 1 && <Th>All together</Th>}
                <Th>Result</Th>
              </tr>
            </thead>
            <tbody>
              {visible.map((b) => (
                <tr key={`${b.time}-${b.cycle ?? 0}`}>
                  <Td className="whitespace-nowrap text-data">
                    {formatMarketTime(b.time, interval)}
                  </Td>
                  {showCycle && <Td className="tabular-nums">{b.cycle ?? '—'}</Td>}
                  {comparisons.map((c) => {
                    const check = b.checks.find((x) => x.id === c.id);
                    return (
                      <Td key={c.id}>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-data">{describeValues(c, check)}</span>
                          {check && <Truth value={check.truth} />}
                        </div>
                      </Td>
                    );
                  })}
                  {comparisons.length > 1 && (
                    <Td>
                      <Truth value={b.truth} />
                    </Td>
                  )}
                  <Td className={cx(b.outcome === 'fired' && 'font-medium')}>
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
        {rows.length > shown && (
          <Button size="sm" variant="ghost" onClick={() => setShown((n) => n + PAGE * 4)}>
            Show earlier bars ({rows.length - shown} more)
          </Button>
        )}
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Orders

function noOrdersText(phase: 'entry' | 'exit', report: PhaseConditionReport): string {
  if (phase === 'entry') {
    return report.fired === 0
      ? 'No Entry orders were planned, because the Entry conditions never fired.'
      : 'No Entry orders were planned.';
  }
  return report.evaluated === 0
    ? 'No Exit orders were planned, because no position was opened.'
    : 'No Exit orders were planned.';
}

function OrderReport({
  title,
  phase,
  orders,
  report,
  interval,
}: {
  title: string;
  phase: 'entry' | 'exit';
  orders: BacktestOrder[];
  report: PhaseConditionReport;
  interval: Interval;
}) {
  return (
    <section aria-label={title} className="mt-5 space-y-3 border-t border-line pt-4">
      <h4 className="text-base font-semibold text-order">{title}</h4>
      {orders.length === 0 ? (
        <p className="text-sm text-ink-muted">{noOrdersText(phase, report)}</p>
      ) : (
        <Table label={title}>
          <thead>
            <tr>
              <Th>Cycle</Th>
              <Th>Order</Th>
              <Th>When</Th>
              <Th>Result</Th>
              <Th>Why</Th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o, i) => {
              const outcome = ORDER_OUTCOMES[o.outcome];
              return (
                <tr key={`${o.cycle}-${o.phase}-${o.legId}-${i}`}>
                  <Td className="tabular-nums">{o.cycle}</Td>
                  <Td className="min-w-56">
                    <div className="font-medium">
                      {o.phase === 'flatten' ? 'Close after a failed leg' : o.legLabel}
                    </div>
                    <div className="text-xs text-ink-muted">{describeOrder(o)}</div>
                  </Td>
                  <Td className="whitespace-nowrap text-data">
                    {o.decidedAt ? (
                      <>
                        <div>{formatMarketTime(o.decidedAt, interval)}</div>
                        {o.activeFrom && o.activeFrom !== o.decidedAt && (
                          <div className="text-xs text-ink-muted">
                            Could fill from {formatMarketTime(o.activeFrom, interval)}
                          </div>
                        )}
                        {o.endedAt && (
                          <div className="text-xs text-ink-muted">
                            {o.outcome === 'filled' ? 'Filled' : 'Ended'}{' '}
                            {formatMarketTime(o.endedAt, interval)}
                          </div>
                        )}
                      </>
                    ) : (
                      'Not sent'
                    )}
                  </Td>
                  <Td>
                    <Badge tone={outcome.tone}>{outcome.label}</Badge>
                  </Td>
                  <Td className="min-w-56">{explainOrder(o)}</Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Selection groups and per-leg conditions (v1.2 items 1 and 2)

export const EXIT_REASON_LABELS: Record<NonNullable<BacktestTradeDto['exitReason']>, string> = {
  condition: 'Exit condition',
  time_stop: 'Time stop',
  atr_stop: 'ATR stop',
  expected_move: 'Beyond the expected move',
  rebalance: 'Rebalance: no longer selected',
};

/** A metric's name with its parameters, e.g. "Return (lookback 6, skip 0)". */
export function describeMetric(ref: SelectionLog['metric']): string {
  if (!ref) return 'No ranking metric';
  const spec = getMetric(ref.metric);
  if (!spec) return ref.metric;
  const params = spec.params
    .filter((p) => p.kind !== 'instrument')
    .map((p) => `${p.label.toLowerCase()} ${ref.params[p.name] ?? p.default}`);
  return params.length > 0 ? `${spec.label} (${params.join(', ')})` : spec.label;
}

function metricText(ref: SelectionLog['metric'], value: string | null): string {
  if (value === null) return '—';
  const unit = ref ? getMetric(ref.metric)?.unit : undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return unit === 'fraction' ? `${(n * 100).toFixed(2)}%` : n.toFixed(2);
}

const yesNo = (v: boolean | null) => (v === null ? 'Unknown' : v ? 'Yes' : 'No');

/** Every round as CSV, one row per member, for checking a ranking by hand. */
export function selectionCsv(log: SelectionLog): string {
  const header = [
    'time',
    'period',
    'gate',
    'symbol',
    'value',
    'filter',
    'rank',
    'selected',
    'excluded',
  ];
  const cell = (v: string | number | boolean | null | undefined) => {
    const s = v === null || v === undefined ? '' : String(v);
    const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const lines = [header.join(',')];
  for (const r of log.rounds) {
    for (const [sym, value, filter, rank, selected, excluded] of r.rows) {
      lines.push(
        [
          r.time,
          r.period,
          r.gate,
          sym,
          value,
          filter,
          rank,
          selected,
          excluded ? (log.exclusionLabels[excluded] ?? excluded) : null,
        ]
          .map(cell)
          .join(','),
      );
    }
  }
  return lines.join('\r\n') + '\r\n';
}

export function SelectionRounds({ log, interval }: { log: SelectionLog; interval: Interval }) {
  const id = useId();
  const [index, setIndex] = useState(log.rounds.length - 1);
  const round: SelectionRound | undefined = log.rounds[index];
  const ranking = log.kind === 'ranking';
  const schedule = SCHEDULE_LABELS[log.schedule as ScheduleFrequency] ?? log.schedule;

  const download = () => {
    const blob = new Blob([selectionCsv(log)], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = ranking ? 'selection-rounds.csv' : 'leg-rounds.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  if (log.rounds.length === 0) {
    return <p className="text-sm text-ink-muted">No round was evaluated in this period.</p>;
  }
  return (
    <div className="space-y-3">
      <p className="text-sm">
        {ranking
          ? `Ranked by ${describeMetric(log.metric)}, ${log.direction === 'desc' ? 'highest first' : 'lowest first'}. `
          : log.metric
            ? `Of the legs whose conditions held, the one with the best ${describeMetric(log.metric)} entered. `
            : 'Each leg whose own conditions held entered. '}
        Evaluated: {schedule.toLowerCase()}. {log.rounds.length}{' '}
        {log.rounds.length === 1 ? 'round' : 'rounds'} recorded.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <SelectField
          name={`${id}-round`}
          label="Round"
          value={String(index)}
          onChange={(e) => setIndex(Number(e.target.value))}
        >
          {log.rounds
            .map((r, i) => ({ r, i }))
            .reverse()
            .map(({ r, i }) => (
              <option key={r.time} value={i}>
                {formatMarketTime(r.time, interval)} ({r.period})
              </option>
            ))}
        </SelectField>
        <Button size="sm" variant="secondary" onClick={download}>
          Download all rounds (CSV)
        </Button>
      </div>
      {round && (
        <>
          <ul className="text-sm">
            {round.gate !== undefined && (
              <li>
                Entry condition (gates the whole selection): <Truth value={round.gate} />
              </li>
            )}
            <li>Entered: {round.entered.length > 0 ? round.entered.join(', ') : 'none'}</li>
            <li>Exited: {round.exited.length > 0 ? round.exited.join(', ') : 'none'}</li>
            {round.halted && (
              <li className="text-danger">
                New entries were held back by the daily loss limit or the drawdown limit.
              </li>
            )}
          </ul>
          <Table label={`Round of ${formatMarketTime(round.time, interval)}`}>
            <thead>
              <tr>
                {ranking && <Th numeric>Rank</Th>}
                <Th>{ranking ? 'Instrument' : 'Leg instrument'}</Th>
                <Th numeric>{log.metric ? describeMetric(log.metric) : 'Value'}</Th>
                <Th>{ranking ? 'Passes pre-filter' : 'Leg condition holds'}</Th>
                <Th>Selected</Th>
                {ranking && <Th>Left out because</Th>}
              </tr>
            </thead>
            <tbody>
              {round.rows.map(([sym, value, filter, rank, selected, excluded]) => (
                <tr key={sym} className={cx(selected && 'font-medium')}>
                  {ranking && <Td numeric>{rank ?? '—'}</Td>}
                  <Td>{sym}</Td>
                  <Td numeric>{metricText(log.metric, value)}</Td>
                  <Td>{yesNo(filter)}</Td>
                  <Td>{selected ? 'Yes' : 'No'}</Td>
                  {ranking && (
                    <Td className="text-xs">
                      {excluded ? (log.exclusionLabels[excluded] ?? excluded) : ''}
                    </Td>
                  )}
                </tr>
              ))}
            </tbody>
          </Table>
        </>
      )}
    </div>
  );
}
