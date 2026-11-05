'use client';

import type { BacktestOrder, PhaseConditionReport, StoredTruth } from '@tm/backtest';
import type { BacktestRunDto } from '@tm/contracts';
import type { Comparison } from '@tm/domain';
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
  return (
    <div className="space-y-6">
      {(['entry', 'exit'] as const).map((phase) => (
        <PhaseReport
          key={phase}
          phase={phase}
          report={conditions[phase]}
          orders={orders.filter((o) =>
            phase === 'entry' ? o.phase === 'entry' : o.phase !== 'entry',
          )}
          symbol={symbol}
          interval={run.inputs.interval}
        />
      ))}
    </div>
  );
}

function PhaseReport({
  phase,
  report,
  orders,
  symbol,
  interval,
}: {
  phase: 'entry' | 'exit';
  report: PhaseConditionReport;
  orders: BacktestOrder[];
  symbol: (id: string) => string | undefined;
  interval: Interval;
}) {
  const id = useId();
  const title = phase === 'entry' ? 'Entry' : 'Exit';
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
        {title}
      </h3>
      <p className="mb-4 text-sm">{summarizeConditions(phase, report)}</p>
      <ConditionReport
        title={`${title} conditions`}
        report={report}
        symbol={symbol}
        interval={interval}
        showCycle={phase === 'exit'}
      />
      <OrderReport
        title={`${title} orders`}
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
              <Th className="text-right">True on</Th>
              <Th className="text-right">False on</Th>
              <Th className="text-right">No data on</Th>
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
                  <Td className="text-right tabular-nums">{s?.trueBars ?? 0}</Td>
                  <Td className="text-right tabular-nums">{s?.falseBars ?? 0}</Td>
                  <Td className="text-right tabular-nums">{s?.unknownBars ?? 0}</Td>
                  <Td className="whitespace-nowrap">
                    {formatMarketTime(s?.firstTrue ?? null, interval)}
                  </Td>
                  <Td>
                    {check ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="tabular-nums">{describeValues(c, check)}</span>
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
                  <Td className="whitespace-nowrap">{formatMarketTime(b.time, interval)}</Td>
                  {showCycle && <Td className="tabular-nums">{b.cycle ?? '—'}</Td>}
                  {comparisons.map((c) => {
                    const check = b.checks.find((x) => x.id === c.id);
                    return (
                      <Td key={c.id}>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="tabular-nums">{describeValues(c, check)}</span>
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
                  <Td className="whitespace-nowrap">
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
