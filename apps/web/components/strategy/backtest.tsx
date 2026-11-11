'use client';

import {
  BACKTEST_LOOKBACK_NAMES,
  BACKTEST_LOOKBACKS,
  DEFAULT_BACKTEST_INPUTS,
  lookbackFits,
  lookbackStart,
  matchingBacktestInterval,
  type BacktestInputs,
  type BacktestInterval,
  type BacktestLookback,
} from '@tm/backtest';
import type { StrategyDefinition } from '@tm/domain';
import {
  ApiError,
  type BacktestRunDto,
  type BacktestRunSummaryDto,
  type BacktestTradeDto,
} from '@tm/contracts';
import { addDays, nyDate, stockGroup } from '@tm/domain';
import {
  Alert,
  Badge,
  Button,
  Card,
  cx,
  SelectField,
  Table,
  Td,
  TextField,
  Th,
  Stat,
} from '@tm/ui';
import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import { LineChart } from '@/components/line-chart';
import { BacktestCycles } from '@/components/strategy/backtest-cycles';
import { PhaseReports, SelectionRounds } from '@/components/strategy/backtest-detail';
import { apiClient } from '@/lib/api-client';
import {
  barsFromStrategy,
  describeRun,
  formatDay,
  formatMarketTime,
  formatMoney,
  formatPct,
  formatSignedMoney,
  isActive,
  metricTiles,
  RUN_STATUS,
  thin,
} from '@/lib/backtest-text';
import { ADJUSTMENT_LABELS } from '@/lib/strategy-text';
import { bare } from '@/lib/units';

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

type MoneyKey =
  | 'initialCapital'
  | 'adjustment'
  | 'slippageBps'
  | 'commissionPerShare'
  | 'commissionMin'
  | 'maxVolumePct'
  | 'borrowRatePct';
type FormValues = Record<MoneyKey, string> & {
  /** The day the run counts back from (N234): today unless picked. */
  endDate: string;
  lookback: BacktestLookback;
  /** Whole group, or only the symbols typed (N235). */
  scope: 'all' | 'some';
  symbols: string;
};
type FieldErrors = Partial<Record<keyof BacktestInputs | keyof FormValues, string>>;

/** The longest look-back up to a year that the strategy's bars allow (N234). */
function defaultLookback(to: string, interval: BacktestInterval): BacktestLookback {
  const fits = BACKTEST_LOOKBACKS.filter((l) => lookbackFits(to, l, interval));
  const upToYear = fits.filter(
    (l) => BACKTEST_LOOKBACKS.indexOf(l) <= BACKTEST_LOOKBACKS.indexOf('1y'),
  );
  return upToYear[upToYear.length - 1] ?? '1w';
}

function defaultValues(interval: BacktestInterval): FormValues {
  const { interval: _bars, ...rest } = DEFAULT_BACKTEST_INPUTS;
  void _bars;
  const today = nyDate(new Date().toISOString());
  return {
    ...rest,
    endDate: today,
    lookback: defaultLookback(today, interval),
    scope: 'all',
    symbols: '',
  };
}

/** Symbols typed for a run, upper case, in order, once each. */
export function parseSymbols(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\s,;]+/)
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
}

/**
 * The run's dates (N234): the period before the end date. Today's bars are
 * still forming, so a run that ends today reads up to yesterday's close.
 */
export function runDates(
  endDate: string,
  lookback: BacktestLookback,
  today: string,
): { from: string; to: string; endsToday: boolean } {
  const endsToday = endDate >= today;
  const to = endsToday ? addDays(today, -1) : endDate;
  const from = lookbackStart(endsToday ? today : endDate, lookback);
  return { from: from > to ? to : from, to, endsToday };
}

function fieldErrorsFrom(e: unknown): FieldErrors {
  if (!(e instanceof ApiError) || !e.body.issues) return {};
  const out: FieldErrors = {};
  for (const issue of e.body.issues) {
    const raw = issue.path[0];
    // The dates are worked out from End date and Look back.
    const key = raw === 'from' ? 'lookback' : raw === 'to' ? 'endDate' : raw;
    if (typeof key === 'string' && !(key in out)) out[key as keyof FieldErrors] = issue.message;
  }
  return out;
}

/** What to trade as the run's instrument choice sees it (N235). */
interface GroupInfo {
  label: string;
  size: number;
  /** Members by symbol, for a list group; absent for a built-in stock group. */
  symbols?: string[];
  has: (symbol: string) => boolean;
}

function groupInfo(
  definition: StrategyDefinition | undefined,
  instruments: readonly { id: string; symbol: string }[],
): GroupInfo | undefined {
  const trade = definition?.trade;
  if (trade?.kind !== 'group') return undefined;
  if (trade.universe.type === 'builtin') {
    const group = stockGroup(trade.universe.id);
    return { label: group.label, size: group.members.size, has: (s) => group.members.has(s) };
  }
  const symbols = trade.universe.instrumentIds.flatMap((id) => {
    const s = instruments.find((i) => i.id === id)?.symbol;
    return s ? [s.toUpperCase()] : [];
  });
  const set = new Set(symbols);
  return { label: 'the list', size: set.size, symbols: [...set], has: (s) => set.has(s) };
}

export function BacktestInputsForm({
  state,
  blocked,
  definition,
  instruments = [],
}: {
  state: BacktestsState;
  /** Why a run can't start now, or null. */
  blocked: string | null;
  /** The rules being tested: they set the bars (N233) and the group (N235). */
  definition?: StrategyDefinition | undefined;
  /** Instruments the editor knows, to name a list group's members. */
  instruments?: readonly { id: string; symbol: string }[] | undefined;
}) {
  const matching = definition ? matchingBacktestInterval(definition) : undefined;
  const interval = matching?.interval ?? DEFAULT_BACKTEST_INPUTS.interval;
  const [values, setValues] = useState<FormValues>(() => defaultValues(interval));
  const today = nyDate(new Date().toISOString());
  // A look-back the strategy's bars can't cover moves to the longest they can.
  useEffect(() => {
    setValues((v) =>
      lookbackFits(v.endDate, v.lookback, interval)
        ? v
        : { ...v, lookback: defaultLookback(v.endDate, interval) },
    );
  }, [interval]);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const hintId = useId();
  const set = (key: keyof FormValues) => (e: { target: { value: string } }) =>
    setValues((v) => ({ ...v, [key]: e.target.value }));

  const group = groupInfo(definition, instruments);
  const picked = group && values.scope === 'some' ? parseSymbols(values.symbols) : [];
  const outside = group ? picked.filter((s) => !group.has(s)) : [];
  const symbolsProblem =
    group && values.scope === 'some'
      ? picked.length === 0
        ? 'Type at least one symbol, or test the whole group'
        : outside.length > 0
          ? `Not in ${group.label}: ${outside.slice(0, 10).join(', ')}`
          : null
      : null;
  const dates = runDates(values.endDate, values.lookback, today);

  const runBlocked =
    blocked ??
    (state.active ? 'A back test of this strategy is running.' : null) ??
    (symbolsProblem ? 'Fix the instruments to test first.' : null);

  async function run() {
    setBusy(true);
    setError(null);
    setErrors({});
    try {
      await state.start({
        from: dates.from,
        to: dates.to,
        lookback: values.lookback,
        interval,
        initialCapital: values.initialCapital,
        adjustment: values.adjustment as BacktestInputs['adjustment'],
        slippageBps: values.slippageBps,
        commissionPerShare: values.commissionPerShare,
        commissionMin: values.commissionMin,
        maxVolumePct: values.maxVolumePct,
        borrowRatePct: values.borrowRatePct,
        ...(group && values.scope === 'some' ? { symbols: picked } : {}),
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

  const field = (key: MoneyKey, label: string, props: Record<string, string> = {}) => (
    <TextField
      name={`bt-${key}`}
      label={label}
      value={values[key]}
      onChange={set(key)}
      error={errors[key]}
      {...props}
    />
  );

  const toggleSymbol = (symbol: string) =>
    setValues((v) => {
      const list = parseSymbols(v.symbols);
      const next = list.includes(symbol) ? list.filter((s) => s !== symbol) : [...list, symbol];
      return { ...v, symbols: next.join(', ') };
    });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!runBlocked) void run();
      }}
    >
      <fieldset className="grid-fields-wide gap-3" disabled={busy}>
        <legend className="sr-only">Back test inputs</legend>
        <TextField
          name="bt-endDate"
          label="End date"
          type="date"
          value={values.endDate}
          max={today}
          onChange={set('endDate')}
          error={errors.endDate}
          hint="The back test counts back from this day. Today unless you pick another."
        />
        <SelectField
          name="bt-lookback"
          label="Look back"
          value={values.lookback}
          onChange={set('lookback')}
          error={errors.lookback}
        >
          {BACKTEST_LOOKBACKS.map((l) => (
            <option key={l} value={l} disabled={!lookbackFits(values.endDate, l, interval)}>
              {BACKTEST_LOOKBACK_NAMES[l]}
            </option>
          ))}
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
      </fieldset>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm" data-testid="bt-plan">
        <dt className="text-ink-muted">Dates</dt>
        <dd className="text-content">
          {formatDay(dates.from)} to {formatDay(dates.to)}
          {dates.endsToday && (
            <span className="text-ink-muted">
              {' '}
              (today&apos;s bars are still forming, so data ends at the last close)
            </span>
          )}
        </dd>
        <dt className="text-ink-muted">Bars</dt>
        <dd className="text-content">{barsFromStrategy(interval, matching?.finest)}</dd>
        <dt className="text-ink-muted">Data</dt>
        <dd className="text-content">Bars from your data feed</dd>
      </dl>
      {group && (
        <fieldset className="mt-3 rounded-md border border-line p-3" disabled={busy}>
          <legend className="px-1 text-sm font-medium">Instruments to test</legend>
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="bt-scope"
                value="all"
                checked={values.scope === 'all'}
                onChange={() => setValues((v) => ({ ...v, scope: 'all' }))}
              />
              Whole group ({group.label}, {group.size}{' '}
              {group.size === 1 ? 'instrument' : 'instruments'})
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="bt-scope"
                value="some"
                checked={values.scope === 'some'}
                onChange={() => setValues((v) => ({ ...v, scope: 'some' }))}
              />
              Only some of them
            </label>
          </div>
          {values.scope === 'some' && (
            <div className="mt-3">
              <TextField
                name="bt-symbols"
                label="Symbols"
                value={values.symbols}
                onChange={set('symbols')}
                placeholder="AAPL, MSFT, NVDA"
                error={errors.symbols ?? symbolsProblem ?? undefined}
                hint={`Separate symbols with commas or spaces. ${
                  picked.length > 0 && !symbolsProblem
                    ? `Tests ${picked.length} of ${group.size}; filters and rankings pick among these only.`
                    : `Any member of ${group.label}.`
                }`}
              />
              {group.symbols && group.symbols.length <= 60 && (
                <div
                  role="group"
                  className="mt-2 flex flex-wrap gap-1"
                  aria-label="Members of the group"
                >
                  {group.symbols.map((s) => {
                    const on = picked.includes(s);
                    return (
                      <button
                        key={s}
                        type="button"
                        aria-pressed={on}
                        onClick={() => toggleSymbol(s)}
                        className={cx(
                          'rounded-full border px-2 py-0.5 text-xs',
                          on
                            ? 'border-info bg-info-soft text-info'
                            : 'border-line text-content hover:bg-surface-2',
                        )}
                      >
                        {s}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </fieldset>
      )}
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
            <Th numeric>Net return %</Th>
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
              <Td numeric>{r.metrics ? bare(formatPct(r.metrics.netReturnPct, true)) : '—'}</Td>
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
      {/* The run's dates, figures, charts and assumptions, collapsed by default (N170). */}
      <details className="mt-3 rounded-md border border-line p-3">
        <summary className="cursor-pointer text-sm font-medium">
          Run summary
          {run.metrics && (
            <span className="ml-2 font-normal text-ink-muted">
              net return {formatPct(run.metrics.netReturnPct, true)}
            </span>
          )}
        </summary>
        <div className="mt-3">
          <p className="text-sm">{describeRun(run)}</p>
          <p className="text-xs text-ink-muted">
            {[
              run.finishedAt && `Finished ${new Date(run.finishedAt).toLocaleString('en-US')}`,
              run.engineVersion && `Engine ${run.engineVersion}`,
              run.dataVersions.length > 0 && `Data ${run.dataVersions.join(', ')}`,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>

          {run.status === 'completed' && run.metrics && run.result && (
            <div className="mt-3 grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
              <div className="min-w-0 space-y-6">
                <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {metricTiles(run.metrics).map((t) => (
                    <Stat
                      key={t.label}
                      className="rounded-md border border-line p-3"
                      label={t.label}
                      value={t.value}
                      comparison={t.detail}
                    />
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
        </div>
      </details>

      {run.status === 'failed' && (
        <div className="mt-3">
          <Alert>{run.error ?? 'The back test failed.'}</Alert>
        </div>
      )}
      {run.status === 'canceled' && (
        <p className="mt-3 text-sm">This back test was canceled before it finished.</p>
      )}

      {run.status === 'completed' && run.metrics && run.result && (
        <div className="mt-6 space-y-6">
          <Section title="Cycles">
            {trades ? (
              <BacktestCycles run={run} trades={trades} />
            ) : (
              <p className="text-sm text-ink-muted">Loading the cycles…</p>
            )}
          </Section>

          <details className="rounded-md border border-line p-3">
            <summary className="cursor-pointer text-base font-semibold">
              Rules and full logs
              {run.result.warnings.length > 0 && (
                <span className="ml-2 text-sm font-normal text-warn">
                  {run.result.warnings.length}{' '}
                  {run.result.warnings.length === 1 ? 'warning' : 'warnings'}
                </span>
              )}
            </summary>
            <div className="mt-4 space-y-6">
              <p className="text-sm text-ink-muted">
                Every bar the conditions were checked on, across all cycles, and the tables behind
                the cycles above.
              </p>
              <Section title="What happened">
                <PhaseReports run={run} />
              </Section>

              {run.result.selections && (
                <Section
                  title={
                    run.result.selections.kind === 'ranking' ? 'Selection rounds' : 'Leg rounds'
                  }
                >
                  <SelectionRounds log={run.result.selections} interval={interval} />
                </Section>
              )}

              {run.result.contributions.length > 0 && (
                <Section title="Contribution by instrument">
                  <Table label="Contribution by instrument">
                    <thead>
                      <tr>
                        <Th>Instrument</Th>
                        <Th>Legs</Th>
                        <Th numeric>Fills</Th>
                        <Th numeric>Gross P/L $</Th>
                        <Th numeric>Costs $</Th>
                        <Th numeric>Net P/L $</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {run.result.contributions.map((c) => (
                        <tr key={c.instrumentId}>
                          <Td className="font-medium">{c.symbol}</Td>
                          <Td>{c.legs.join(', ') || '—'}</Td>
                          <Td numeric>{c.fills}</Td>
                          <Td numeric>{bare(formatSignedMoney(c.grossPnl))}</Td>
                          <Td numeric>{bare(formatMoney(c.costs))}</Td>
                          <Td numeric>{bare(formatSignedMoney(c.netPnl))}</Td>
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
          </details>
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
