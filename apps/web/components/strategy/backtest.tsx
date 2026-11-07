'use client';

import { DEFAULT_BACKTEST_INPUTS, type BacktestInputs } from '@tm/backtest';
import {
  ApiError,
  type BacktestRunDto,
  type BacktestRunSummaryDto,
  type BacktestTradeDto,
} from '@tm/contracts';
import { addDays, nyDate } from '@tm/domain';
import { Alert, Badge, Button, Card, SelectField, Table, Td, TextField, Th } from '@tm/ui';
import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import { LineChart } from '@/components/line-chart';
import {
  EXIT_REASON_LABELS,
  PhaseReports,
  SelectionRounds,
} from '@/components/strategy/backtest-detail';
import { apiClient } from '@/lib/api-client';
import {
  describeRun,
  formatMarketTime,
  formatMoney,
  formatPct,
  formatSignedMoney,
  isActive,
  metricTiles,
  RUN_STATUS,
  sizingText,
  atrStopText,
  thin,
  DIRECTION_WORDS,
  tradeDirection,
} from '@/lib/backtest-text';
import { ADJUSTMENT_LABELS, SIDE_LABELS } from '@/lib/strategy-text';

/**
 * Back Test inputs, run status, history and results (Design v1.0 §7.1, §7.3).
 * Runs are queued on the server and picked up by the worker, so the panel
 * polls an active run until it finishes.
 */

const POLL_MS = 1000;

export interface BacktestsState {
  runs: BacktestRunSummaryDto[] | null;
  loadError: string | null;
  selected: { run: BacktestRunDto; trades: BacktestTradeDto[] | null } | null;
  active: BacktestRunSummaryDto | undefined;
  select: (runId: string) => void;
  start: (inputs: BacktestInputs) => Promise<void>;
  cancel: (runId: string) => Promise<void>;
}

export function useBacktests(strategyId: string): BacktestsState {
  const [runs, setRuns] = useState<BacktestRunSummaryDto[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<BacktestsState['selected']>(null);

  useEffect(() => {
    let cancelled = false;
    apiClient.backtests.list(strategyId).then(
      ({ runs: list }) => {
        if (cancelled) return;
        setRuns(list);
        setSelectedId((id) => id ?? list[0]?.id ?? null);
      },
      () => !cancelled && setLoadError('Could not load back tests.'),
    );
    return () => {
      cancelled = true;
    };
  }, [strategyId]);

  const active = runs?.find((r) => isActive(r.status));

  // Poll the active run until it finishes.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      apiClient.backtests.get(active.id).then(
        (run) => {
          if (cancelled) return;
          setRuns((list) => list?.map((r) => (r.id === run.id ? run : r)) ?? null);
        },
        () => undefined,
      );
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [active]);

  // Load the selected run's results once it has finished.
  const selectedSummary = runs?.find((r) => r.id === selectedId);
  const selectedStatus = selectedSummary?.status;
  useEffect(() => {
    if (!selectedId || !selectedStatus) {
      setSelected(null);
      return;
    }
    let cancelled = false;
    if (isActive(selectedStatus)) {
      setSelected(null);
      return;
    }
    Promise.all([
      apiClient.backtests.get(selectedId),
      selectedStatus === 'completed'
        ? apiClient.backtests.trades(selectedId).then((t) => t.trades)
        : Promise.resolve(null),
    ]).then(
      ([run, trades]) => !cancelled && setSelected({ run, trades }),
      () => !cancelled && setLoadError('Could not load the back test results.'),
    );
    return () => {
      cancelled = true;
    };
  }, [selectedId, selectedStatus]);

  const start = useCallback(
    async (inputs: BacktestInputs) => {
      const run = await apiClient.backtests.start(strategyId, inputs);
      setRuns((list) => [run, ...(list ?? [])]);
      setSelectedId(run.id);
    },
    [strategyId],
  );

  const cancel = useCallback(async (runId: string) => {
    const run = await apiClient.backtests.cancel(runId);
    setRuns((list) => list?.map((r) => (r.id === run.id ? run : r)) ?? null);
  }, []);

  return { runs, loadError, selected, active, select: setSelectedId, start, cancel };
}

// ---------------------------------------------------------------------------
// Inputs

type FormValues = Record<keyof BacktestInputs, string>;
type FieldErrors = Partial<Record<keyof BacktestInputs, string>>;

/** A year of daily bars ending yesterday. */
function defaultValues(): FormValues {
  const to = addDays(nyDate(new Date().toISOString()), -1);
  return { ...DEFAULT_BACKTEST_INPUTS, from: addDays(to, -364), to };
}

function fieldErrorsFrom(e: unknown): FieldErrors {
  if (!(e instanceof ApiError) || !e.body.issues) return {};
  const out: FieldErrors = {};
  for (const issue of e.body.issues) {
    const key = issue.path[0];
    if (typeof key === 'string' && !(key in out)) out[key as keyof BacktestInputs] = issue.message;
  }
  return out;
}

export function BacktestInputsForm({
  state,
  blocked,
}: {
  state: BacktestsState;
  /** Why a run can't start now, or null. */
  blocked: string | null;
}) {
  const [values, setValues] = useState<FormValues>(defaultValues);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const hintId = useId();
  const set = (key: keyof FormValues) => (e: { target: { value: string } }) =>
    setValues((v) => ({ ...v, [key]: e.target.value }));

  const runBlocked = blocked ?? (state.active ? 'A back test of this strategy is running.' : null);

  async function run() {
    setBusy(true);
    setError(null);
    setErrors({});
    try {
      await state.start({
        ...values,
        interval: values.interval as BacktestInputs['interval'],
        adjustment: values.adjustment as BacktestInputs['adjustment'],
      });
    } catch (e) {
      const fields = fieldErrorsFrom(e);
      setErrors(fields);
      setError(
        e instanceof ApiError
          ? Object.keys(fields).length > 0
            ? 'Some back test inputs need attention.'
            : e.message
          : 'Could not start the back test. Try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  const field = (key: keyof FormValues, label: string, props: Record<string, string> = {}) => (
    <TextField
      name={`bt-${key}`}
      label={label}
      value={values[key]}
      onChange={set(key)}
      error={errors[key]}
      {...props}
    />
  );

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!runBlocked) void run();
      }}
    >
      <fieldset className="grid-fields-wide gap-3" disabled={busy}>
        <legend className="sr-only">Back test inputs</legend>
        {field('from', 'From', { type: 'date' })}
        {field('to', 'To', { type: 'date' })}
        <SelectField
          name="bt-interval"
          label="Bars"
          value={values.interval}
          onChange={set('interval')}
          error={errors.interval}
          hint="Up to 5 years daily or 1 year hourly"
        >
          <option value="1d">Daily</option>
          <option value="1h">Hourly</option>
        </SelectField>
        {field('initialCapital', 'Initial capital (USD)', { inputMode: 'decimal' })}
        <SelectField
          name="bt-adjustment"
          label="Price adjustment"
          value={values.adjustment}
          onChange={set('adjustment')}
          error={errors.adjustment}
        >
          {Object.entries(ADJUSTMENT_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </SelectField>
        <div className="flex items-end text-sm text-ink-muted">Data: bars from your data feed</div>
      </fieldset>
      <details className="mt-3 rounded-md border border-line p-3">
        <summary className="cursor-pointer text-sm font-medium">Costs and fills</summary>
        <fieldset className="mt-3 grid-fields-wide gap-3" disabled={busy}>
          {field('slippageBps', 'Slippage (basis points)', { inputMode: 'decimal' })}
          {field('commissionPerShare', 'Commission per share (USD)', { inputMode: 'decimal' })}
          {field('commissionMin', 'Minimum commission per fill (USD)', { inputMode: 'decimal' })}
          {field('maxVolumePct', "Largest share of a bar's volume (%)", { inputMode: 'decimal' })}
          {field('borrowRatePct', 'Short borrow cost (% a year)', { inputMode: 'decimal' })}
        </fieldset>
      </details>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          variant="primary"
          disabled={runBlocked !== null || busy}
          aria-describedby={runBlocked ? hintId : undefined}
        >
          Run back test
        </Button>
        {runBlocked && (
          <p id={hintId} className="text-sm text-ink-muted">
            {runBlocked}
          </p>
        )}
      </div>
      {error && (
        <div className="mt-3">
          <Alert>{error}</Alert>
        </div>
      )}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Status and history

export function RunStatusBadge({ status }: { status: BacktestRunSummaryDto['status'] }) {
  const s = RUN_STATUS[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

/** The active run's progress, announced politely to screen readers. */
export function ActiveRun({ state }: { state: BacktestsState }) {
  const [busy, setBusy] = useState(false);
  const run = state.active;
  return (
    <div role="status" aria-live="polite" className="mt-3 text-sm">
      {run && (
        <div className="flex flex-wrap items-center gap-3 rounded-md bg-surface-2 p-3">
          <RunStatusBadge status={run.status} />
          <span>
            {run.status === 'queued' ? 'Waiting for a worker…' : 'Running the back test…'}{' '}
            {describeRun(run)}
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            disabled={busy || run.cancelRequested}
            onClick={async () => {
              setBusy(true);
              try {
                await state.cancel(run.id);
              } finally {
                setBusy(false);
              }
            }}
          >
            {run.cancelRequested ? 'Canceling…' : 'Cancel back test'}
          </Button>
        </div>
      )}
    </div>
  );
}

export function RunHistory({ state }: { state: BacktestsState }) {
  const runs = state.runs ?? [];
  if (runs.length === 0) return null;
  const selectedId = state.selected?.run.id;
  return (
    <section aria-labelledby="bt-history-heading" className="mt-4">
      <h3 id="bt-history-heading" className="mb-2 text-sm font-semibold">
        Back test history
      </h3>
      <Table label="Back test history">
        <thead>
          <tr>
            <Th>Run</Th>
            <Th>Status</Th>
            <Th className="text-right">Net return</Th>
            <Th>
              <span className="sr-only">Actions</span>
            </Th>
          </tr>
        </thead>
        <tbody>
          {runs.slice(0, 10).map((r) => (
            <tr key={r.id} aria-current={r.id === selectedId ? 'true' : undefined}>
              <Td>
                <div>{describeRun(r)}</div>
                <div className="text-xs text-ink-muted">
                  Started {new Date(r.createdAt).toLocaleString('en-US')}
                </div>
              </Td>
              <Td>
                <RunStatusBadge status={r.status} />
              </Td>
              <Td className="text-right tabular-nums">
                {r.metrics ? formatPct(r.metrics.netReturnPct, true) : '—'}
              </Td>
              <Td className="text-right">
                {!isActive(r.status) && r.id !== selectedId && (
                  <Button size="sm" variant="ghost" onClick={() => state.select(r.id)}>
                    Show results
                  </Button>
                )}
                {r.id === selectedId && <span className="text-xs text-ink-muted">Showing</span>}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Results

const TRADE_STATUS: Record<BacktestTradeDto['status'], string> = {
  closed: 'Closed',
  open: 'Open at end',
  aborted: 'Entry not filled',
};

function TradeLegs({ trade }: { trade: BacktestTradeDto }) {
  if (trade.legs.length === 0) return <span className="text-ink-muted">No fills</span>;
  return (
    <ul className="space-y-0.5">
      {trade.legs.map((l) => (
        <li key={`${l.phase}-${l.legId}`} className="whitespace-nowrap">
          {l.phase === 'flatten' ? 'Closed after a failed leg: ' : ''}
          {SIDE_LABELS[l.side]} {l.quantity} {l.symbol}
          {l.averagePrice ? ` at ${formatMoney(l.averagePrice)}` : ''}
        </li>
      ))}
    </ul>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="space-y-2">
      <h3 id={id} className="text-base font-semibold">
        {title}
      </h3>
      {children}
    </section>
  );
}

export function BacktestResults({ state }: { state: BacktestsState }) {
  const selected = state.selected;
  if (!selected) return null;
  const { run, trades } = selected;
  const sized = trades?.some((t) => t.sizing) ?? false;
  const interval = run.inputs.interval;
  return (
    <Card aria-labelledby="bt-results-heading">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="bt-results-heading" className="text-lg font-semibold">
          Back test results
        </h2>
        <RunStatusBadge status={run.status} />
        {run.status === 'completed' && (
          <a
            href={apiClient.backtests.exportUrl(run.id)}
            download
            className="ml-auto text-sm underline"
          >
            Download trades (CSV)
          </a>
        )}
      </div>
      <p className="mt-1 text-sm">{describeRun(run)}</p>
      <p className="text-xs text-ink-muted">
        {[
          run.finishedAt && `Finished ${new Date(run.finishedAt).toLocaleString('en-US')}`,
          run.engineVersion && `Engine ${run.engineVersion}`,
          run.dataVersions.length > 0 && `Data ${run.dataVersions.join(', ')}`,
        ]
          .filter(Boolean)
          .join(' · ')}
      </p>

      {run.status === 'failed' && (
        <div className="mt-3">
          <Alert>{run.error ?? 'The back test failed.'}</Alert>
        </div>
      )}
      {run.status === 'canceled' && (
        <p className="mt-3 text-sm">This back test was canceled before it finished.</p>
      )}

      {run.status === 'completed' && run.metrics && run.result && (
        <div className="mt-4 grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="min-w-0 space-y-6">
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {metricTiles(run.metrics).map((t) => (
                <div key={t.label} className="rounded-md border border-line p-3">
                  <dt className="text-xs text-ink-muted">{t.label}</dt>
                  <dd className="text-lg font-semibold tabular-nums">{t.value}</dd>
                  {t.detail && <dd className="text-xs text-ink-muted">{t.detail}</dd>}
                </div>
              ))}
            </dl>

            {run.result.equity.length > 0 && <Charts run={run} />}
          </div>

          <aside aria-labelledby="bt-assumptions-heading" className="space-y-2 text-sm">
            <h3 id="bt-assumptions-heading" className="text-base font-semibold">
              Assumptions
            </h3>
            <ul className="list-disc space-y-1 pl-5">
              {run.result.assumptions.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
            <p className="text-xs text-ink-muted">Sharpe ratio: {run.result.sharpeMethod}</p>
          </aside>
        </div>
      )}

      {run.status === 'completed' && run.metrics && run.result && (
        <div className="mt-6 space-y-6">
          <Section title="What happened">
            <PhaseReports run={run} />
          </Section>

          {run.result.selections && (
            <Section
              title={run.result.selections.kind === 'ranking' ? 'Selection rounds' : 'Leg rounds'}
            >
              <SelectionRounds log={run.result.selections} interval={interval} />
            </Section>
          )}

          <Section title="Trades">
            {trades && trades.length > 0 ? (
              <Table label="Trades">
                <thead>
                  <tr>
                    <Th>Cycle</Th>
                    <Th>Direction</Th>
                    <Th>Entry</Th>
                    <Th>Exit</Th>
                    <Th>Legs</Th>
                    {sized && <Th>Sizing</Th>}
                    <Th className="text-right">Net P/L</Th>
                    <Th className="text-right">Return</Th>
                  </tr>
                </thead>
                <tbody>
                  {trades.map((t) => (
                    <tr key={t.cycle}>
                      <Td>
                        <div>{t.cycle}</div>
                        <div className="text-xs text-ink-muted">{TRADE_STATUS[t.status]}</div>
                      </Td>
                      <Td>
                        <div>{DIRECTION_WORDS[tradeDirection(t)]}</div>
                        {t.group && <div className="text-xs text-ink-muted">{t.group}</div>}
                      </Td>
                      <Td className="whitespace-nowrap">
                        {formatMarketTime(t.entryTime, interval)}
                      </Td>
                      <Td className="whitespace-nowrap">
                        <div>{formatMarketTime(t.exitTime, interval)}</div>
                        {t.exitReason && (
                          <div className="text-xs text-ink-muted">
                            {EXIT_REASON_LABELS[t.exitReason]}
                          </div>
                        )}
                        {t.atrStop && (
                          <div className="text-xs text-ink-muted">{atrStopText(t.atrStop)}</div>
                        )}
                      </Td>
                      <Td>
                        <TradeLegs trade={t} />
                      </Td>
                      {sized && (
                        <Td className="min-w-56 text-xs">
                          {t.sizing ? (
                            <>
                              <div className="font-medium">Risk % of equity, ATR stop</div>
                              {sizingText(t.sizing).map((line) => (
                                <div key={line} className="text-ink-muted">
                                  {line}
                                </div>
                              ))}
                            </>
                          ) : (
                            <span className="text-ink-muted">As set on the leg</span>
                          )}
                        </Td>
                      )}
                      <Td className="text-right tabular-nums">{formatSignedMoney(t.netPnl)}</Td>
                      <Td className="text-right tabular-nums">{formatPct(t.returnPct, true)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <p className="text-sm text-ink-muted">The strategy made no trades in this period.</p>
            )}
            <p className="text-xs text-ink-muted">Times are New York market time.</p>
          </Section>

          {run.result.contributions.length > 0 && (
            <Section title="Contribution by instrument">
              <Table label="Contribution by instrument">
                <thead>
                  <tr>
                    <Th>Instrument</Th>
                    <Th>Legs</Th>
                    <Th className="text-right">Fills</Th>
                    <Th className="text-right">Gross P/L</Th>
                    <Th className="text-right">Costs</Th>
                    <Th className="text-right">Net P/L</Th>
                  </tr>
                </thead>
                <tbody>
                  {run.result.contributions.map((c) => (
                    <tr key={c.instrumentId}>
                      <Td className="font-medium">{c.symbol}</Td>
                      <Td>{c.legs.join(', ') || '—'}</Td>
                      <Td className="text-right tabular-nums">{c.fills}</Td>
                      <Td className="text-right tabular-nums">{formatSignedMoney(c.grossPnl)}</Td>
                      <Td className="text-right tabular-nums">{formatMoney(c.costs)}</Td>
                      <Td className="text-right tabular-nums">{formatSignedMoney(c.netPnl)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Section>
          )}

          <Section title="Warnings">
            {run.result.warnings.length > 0 ? (
              <ul className="space-y-1 text-sm">
                {run.result.warnings.map((w) => (
                  <li key={w.code} className="flex gap-2">
                    <Badge tone="warn">Warning</Badge>
                    <span>
                      {w.message}
                      {w.count > 1 ? ` (${w.count} times)` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-ink-muted">No warnings.</p>
            )}
          </Section>
        </div>
      )}
    </Card>
  );
}

function Charts({ run }: { run: BacktestRunDto }) {
  const points = thin(run.result?.equity ?? []);
  const equity = points.map((p) => Number(p.equity));
  const exposure = points.map((p) => Number(p.grossExposure));
  const times = points.map((p) => formatMarketTime(p.time, run.inputs.interval));
  const first = equity[0] ?? 0;
  const last = equity.at(-1) ?? 0;
  return (
    <div className="grid gap-3">
      <LineChart
        title="Equity"
        values={equity}
        times={[times[0] ?? '', times.at(-1) ?? '']}
        summary={`Equity from ${formatMoney(first)} to ${formatMoney(last)}, lowest ${formatMoney(Math.min(...equity))}, highest ${formatMoney(Math.max(...equity))}`}
      />
      <LineChart
        title="Gross exposure"
        values={exposure}
        times={[times[0] ?? '', times.at(-1) ?? '']}
        summary={`Gross exposure between ${formatMoney(Math.min(...exposure))} and ${formatMoney(Math.max(...exposure))}`}
      />
    </div>
  );
}
