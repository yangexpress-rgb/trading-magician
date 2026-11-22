'use client';

import {
  ApiError,
  type PerformanceQuery,
  type PerformanceSummaryDto,
  type PerformanceTimeseriesDto,
  type PerformanceTradeDto,
  type PositionDto,
} from '@tm/contracts';
import { formatDateTime, type DisplayPreferences } from '@tm/domain';
import {
  Alert,
  Badge,
  Card,
  ChartIcon,
  EmptyState,
  SelectField,
  Table,
  Td,
  TextField,
  Th,
} from '@tm/ui';
import Link from 'next/link';
import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import { LineChart } from '@/components/line-chart';
import { Signed, TileValue } from '@/components/signed';
import { apiClient } from '@/lib/api-client';
import { formatDay, formatMoney, formatPct, formatSignedMoney } from '@/lib/backtest-text';
import { subscribeLive } from '@/lib/live-events';
import {
  ASSET_CLASS_LABELS,
  assetChoices,
  describePositionDifference,
  filtersFromSearch,
  performanceSearch,
  performanceLayout,
  type PerformanceLayout,
  type PerformanceFilters,
} from '@/lib/performance-text';
import { AccountLabel, accountText } from '@/components/accounts/account-label';

/**
 * The Performance tab (Design v1.0 §10, §15.3; ADR 0021): filters, headline
 * figures, equity and drawdown, contribution by strategy and asset, trades
 * with each leg's part, open positions, and data-quality notes. All figures
 * come from reconciled fills and stored valuations; amounts are USD.
 */

interface Data {
  summary: PerformanceSummaryDto;
  series: PerformanceTimeseriesDto;
  trades: PerformanceTradeDto[];
  positions: PositionDto[];
}

function toQuery(f: PerformanceFilters): PerformanceQuery {
  return {
    from: f.from,
    to: f.to,
    accountId: f.accountId,
    strategyId: f.strategyId,
    versionId: f.versionId,
    assetClass: f.assetClass as PerformanceQuery['assetClass'],
    mode: f.mode,
  };
}

function usePerformance(filters: PerformanceFilters) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const q = toQuery(filters);
    try {
      const [summary, series, trades, positions] = await Promise.all([
        apiClient.performance.summary(q),
        apiClient.performance.timeseries(q),
        apiClient.performance.trades(q),
        apiClient.positions.list(),
      ]);
      setData({ summary, series, trades: trades.trades, positions: positions.positions });
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Performance could not be loaded.');
    }
  }, [filters]);
  useEffect(() => {
    void load();
    // Valuations and fills announce themselves on the shared change stream.
    return subscribeLive({ onChange: () => void load() });
  }, [load]);
  return { data, error };
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="space-y-2">
      <h2 id={id} className="text-lg font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** A strategy's own S number in its own column (N284); a dash when it has none. */
function StrategyNumberCell({ number }: { number: string | null }) {
  return <Td className="whitespace-nowrap font-mono text-xs">{number ?? '—'}</Td>;
}

function Charts({ series }: { series: PerformanceTimeseriesDto }) {
  const points = series.points;
  if (points.length < 2) {
    return (
      <p className="text-sm text-ink-muted">
        Charts appear once there are valuations from two or more sessions.
      </p>
    );
  }
  const dates = [formatDay(points[0]?.date ?? ''), formatDay(points.at(-1)?.date ?? '')];
  const main = series.filtered
    ? points.map((p) => Number(p.pnl))
    : points.map((p) => Number(p.equity ?? 0));
  const drawdown = points.map((p) => -Number(series.filtered ? p.drawdown : (p.drawdownPct ?? 0)));
  const worst = Math.min(...drawdown);
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <LineChart
        title={series.filtered ? 'Profit and loss' : 'Equity'}
        values={main}
        times={dates}
        summary={`${series.filtered ? 'Profit and loss' : 'Equity'} from ${formatMoney(main[0] ?? 0)} to ${formatMoney(main.at(-1) ?? 0)} over ${points.length} sessions, lowest ${formatMoney(Math.min(...main))}, highest ${formatMoney(Math.max(...main))}`}
      />
      <LineChart
        title="Drawdown"
        values={drawdown}
        times={dates}
        format={series.filtered ? formatMoney : (v) => formatPct(v)}
        summary={`Deepest drawdown ${series.filtered ? formatMoney(-worst) : formatPct(-worst)} below the running peak`}
      />
    </div>
  );
}

function Legs({ trade }: { trade: PerformanceTradeDto }) {
  return (
    <ul className="space-y-0.5">
      {trade.legs.map((l) => (
        <li key={`${l.legLabel}-${l.instrumentId}-${l.side}`} className="whitespace-nowrap">
          {l.legLabel}: {l.side === 'long' ? 'long' : 'short'} {l.opened} {l.symbol} at{' '}
          {formatMoney(l.averageOpen)}
          {l.averageClose ? `, closed ${l.closed} at ${formatMoney(l.averageClose)}` : ', open'} (
          <Signed value={l.net}>{formatSignedMoney(l.net)}</Signed>)
        </li>
      ))}
    </ul>
  );
}

function DataQuality({
  summary,
  when,
}: {
  summary: PerformanceSummaryDto;
  when: (iso: string | null) => string;
}) {
  const q = summary.dataQuality;
  return (
    <Section title="Data quality and reconciliation">
      <ul className="list-disc space-y-1 pl-5 text-sm">
        <li>
          {q.lastValuedAt
            ? `Valued from reconciled fills and the latest prices, last at ${when(q.lastValuedAt)}. Figures can lag a fill by a few minutes.`
            : 'No valuation yet: the account is valued every few minutes once it has activity.'}
        </li>
        {q.staleMarks > 0 && (
          <li>
            {q.staleMarks === 1
              ? '1 open holding is valued at a price more than a minute old.'
              : `${q.staleMarks} open holdings are valued at prices more than a minute old.`}
          </li>
        )}
        {summary.shortHistory && (
          <li>
            This range has {summary.sessions === 1 ? '1 session' : `${summary.sessions} sessions`}{' '}
            of history, so drawdown and the Sharpe ratio say little yet.
          </li>
        )}
        <li>Amounts are in US dollars. Paper fills carry no fees.</li>
        <li>
          <Link href="/performance/methodology" className="underline">
            How these figures are calculated
          </Link>
        </li>
      </ul>
      {q.differences.length === 0 ? (
        <p className="text-sm">The app and the broker agreed at every close in this range.</p>
      ) : (
        <>
          <Alert>
            The broker&apos;s figures differ from the app&apos;s at{' '}
            {q.differences.length === 1 ? '1 close' : `${q.differences.length} closes`}. The
            broker&apos;s figures are the ones that count.
          </Alert>
          <Table label="Differences with the broker">
            <thead>
              <tr>
                <Th>Close</Th>
                <Th>Account</Th>
                <Th numeric>App equity</Th>
                <Th numeric>Broker equity</Th>
                <Th>Holdings</Th>
              </tr>
            </thead>
            <tbody>
              {q.differences.map((d) => (
                <tr key={`${d.accountId}-${d.sessionDate}`}>
                  <Td className="whitespace-nowrap text-content">{formatDay(d.sessionDate)}</Td>
                  <Td>{d.accountName}</Td>
                  <Td numeric>{d.appEquity ? formatMoney(d.appEquity) : '—'}</Td>
                  <Td numeric>
                    {d.brokerEquity ? formatMoney(d.brokerEquity) : 'Not reported'}
                    {d.equityDifference && Math.abs(Number(d.equityDifference)) > 1 && (
                      <div className="text-xs">
                        {formatSignedMoney(d.equityDifference)} against the app
                      </div>
                    )}
                  </Td>
                  <Td>
                    {d.positions.length === 0 ? (
                      'Agree'
                    ) : (
                      <ul>
                        {d.positions.map((p) => (
                          <li key={p.instrumentId}>{describePositionDifference(p)}</li>
                        ))}
                      </ul>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </>
      )}
    </Section>
  );
}

export function PerformanceView({
  prefs,
  initialFilters,
  accounts,
  strategies,
}: {
  prefs: DisplayPreferences;
  initialFilters: PerformanceFilters;
  accounts: { id: string; name: string; mode: 'paper' | 'live' }[];
  strategies: {
    id: string;
    name: string;
    labNumber: string | null;
    versions: { id: string; versionNo: number }[];
  }[];
}) {
  const [filters, setFilters] = useState<PerformanceFilters>(initialFilters);
  const { data, error } = usePerformance(filters);
  const set = (patch: Partial<PerformanceFilters>) => setFilters((f) => ({ ...f, ...patch }));

  useEffect(() => {
    const search = performanceSearch(filters);
    if (window.location.search === search) return;
    window.history.replaceState(null, '', `${window.location.pathname}${search}`);
  }, [filters]);

  // Back and Forward step between views opened from a strategy row (N297).
  useEffect(() => {
    const onPop = () => {
      const params = new URLSearchParams(window.location.search);
      setFilters(filtersFromSearch((k) => params.get(k) ?? undefined));
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  /** Double-click (or Enter on) a strategy row: that strategy's own view, as a new address (N297). */
  const openStrategy = (strategyId: string) => {
    if (filters.strategyId === strategyId) return;
    const next: PerformanceFilters = { ...filters, strategyId, versionId: undefined };
    window.history.pushState(null, '', `${window.location.pathname}${performanceSearch(next)}`);
    setFilters(next);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const when = (iso: string | null) =>
    iso
      ? formatDateTime(iso, prefs, {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        })
      : '—';
  const versions = strategies.find((s) => s.id === filters.strategyId)?.versions ?? [];
  const summary = data?.summary;
  const positions = (data?.positions ?? []).filter(
    (p) =>
      (!filters.accountId || p.accountId === filters.accountId) &&
      (!filters.strategyId || p.strategyId === filters.strategyId),
  );
  const nothing =
    summary &&
    summary.trades.count === 0 &&
    summary.byStrategy.length === 0 &&
    positions.length === 0 &&
    !summary.filtered &&
    !filters.from &&
    !filters.to &&
    !filters.accountId &&
    filters.mode === 'paper';

  return (
    <div className="space-y-6">
      <form
        aria-label="Performance filters"
        className="grid-fields gap-3"
        onSubmit={(e) => e.preventDefault()}
      >
        <TextField
          label="From"
          name="from"
          type="date"
          value={filters.from ?? ''}
          onChange={(e) => set({ from: e.target.value || undefined })}
        />
        <TextField
          label="To"
          name="to"
          type="date"
          value={filters.to ?? ''}
          onChange={(e) => set({ to: e.target.value || undefined })}
        />
        <SelectField
          label="Account"
          name="account"
          value={filters.accountId ?? ''}
          onChange={(e) => set({ accountId: e.target.value || undefined })}
        >
          <option value="">All accounts</option>
          {(['paper', 'live'] as const).map((mode) => {
            const group = accounts.filter((a) => a.mode === mode);
            return group.length === 0 ? null : (
              <optgroup key={mode} label={mode === 'paper' ? 'Paper' : 'Live'}>
                {group.map((a) => (
                  <option key={a.id} value={a.id}>
                    {accountText(a.name, a.mode)}
                  </option>
                ))}
              </optgroup>
            );
          })}
        </SelectField>
        <SelectField
          label="Strategy"
          name="strategy"
          value={filters.strategyId ?? ''}
          onChange={(e) => set({ strategyId: e.target.value || undefined, versionId: undefined })}
        >
          <option value="">All strategies</option>
          {strategies.map((s) => (
            <option key={s.id} value={s.id}>
              {s.labNumber ? `${s.labNumber} ${s.name}` : s.name}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Version"
          name="version"
          value={filters.versionId ?? ''}
          disabled={versions.length === 0}
          onChange={(e) => set({ versionId: e.target.value || undefined })}
        >
          <option value="">All versions</option>
          {versions.map((v) => (
            <option key={v.id} value={v.id}>
              Version {v.versionNo}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Asset class"
          name="class"
          value={filters.assetClass ?? ''}
          onChange={(e) => set({ assetClass: e.target.value || undefined })}
        >
          <option value="">All asset classes</option>
          {assetChoices(data?.summary.assetClasses, filters.assetClass).map((c) => (
            <option key={c} value={c}>
              {ASSET_CLASS_LABELS[c] ?? c}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Mode"
          name="mode"
          value={filters.mode}
          onChange={(e) => set({ mode: e.target.value === 'live' ? 'live' : 'paper' })}
        >
          <option value="paper">Paper</option>
          <option value="live">Live</option>
        </SelectField>
      </form>

      {error && <Alert>{error}</Alert>}
      {filters.mode === 'live' && (
        <p className="text-sm">Live trading is not available yet, so there are no live results.</p>
      )}

      {!data || !summary ? (
        !error && <p className="text-sm">Loading performance…</p>
      ) : nothing ? (
        <EmptyState icon={<ChartIcon />} title="Nothing to measure yet">
          Performance is calculated from filled orders. Once a paper strategy has traded, its
          results will show here.
        </EmptyState>
      ) : (
        <>
          <Card aria-label="Headline figures">
            <HeadlineFigures layout={performanceLayout(summary)} />
          </Card>

          <Charts series={data.series} />

          <div className="grid gap-6 lg:grid-cols-2">
            <Section title="Contribution by strategy">
              {summary.byStrategy.length === 0 ? (
                <p className="text-sm text-ink-muted">No strategy results in this view.</p>
              ) : (
                <Table label="Contribution by strategy">
                  <thead>
                    <tr>
                      <Th>Number</Th>
                      <Th>Strategy</Th>
                      <Th>Account</Th>
                      <Th numeric>Closed trades</Th>
                      <Th numeric>Today</Th>
                      <Th numeric>Net P/L</Th>
                      <Th numeric>Return on peak capital</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.byStrategy.map((s) => (
                      <tr
                        key={`${s.strategyId}-${s.accountId}`}
                        tabIndex={filters.strategyId === s.strategyId ? undefined : 0}
                        title={
                          filters.strategyId === s.strategyId
                            ? undefined
                            : "Double-click to see this strategy's performance"
                        }
                        aria-label={
                          filters.strategyId === s.strategyId
                            ? undefined
                            : `${s.strategyNumber ? `${s.strategyNumber} ` : ''}${s.strategyName}: double-click or press Enter to see its performance`
                        }
                        className={
                          filters.strategyId === s.strategyId
                            ? undefined
                            : 'cursor-pointer select-none hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent'
                        }
                        onDoubleClick={() => openStrategy(s.strategyId)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && e.target === e.currentTarget) {
                            openStrategy(s.strategyId);
                          }
                        }}
                      >
                        <StrategyNumberCell number={s.strategyNumber} />
                        <Td className="font-medium">{s.strategyName}</Td>
                        <Td sortValue={s.accountName} className="text-xs">
                          <AccountLabel name={s.accountName} mode={s.accountMode} />
                        </Td>
                        <Td numeric>{s.closedTrades}</Td>
                        <Td numeric>
                          <Signed value={s.todayPnl}>{formatSignedMoney(s.todayPnl)}</Signed>
                          <div className="text-xs">
                            <Signed value={s.todayPct}>{formatPct(s.todayPct, true)}</Signed>
                          </div>
                        </Td>
                        <Td numeric>
                          <Signed value={s.net}>{formatSignedMoney(s.net)}</Signed>
                        </Td>
                        <Td numeric>
                          <Signed value={s.returnOnPeakCapitalPct}>
                            {formatPct(s.returnOnPeakCapitalPct, true)}
                          </Signed>
                          <div className="text-xs text-ink-muted">
                            of {formatMoney(s.peakCapital)}
                          </div>
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
              {summary.byStrategy.length > 1 && (
                <p className="text-xs text-ink-muted">
                  Double-click a strategy to see its own performance. Today is the NYSE session of{' '}
                  {formatDay(summary.today.sessionDate)}.
                </p>
              )}
            </Section>
            <Section title="Contribution by asset">
              {summary.byAsset.length === 0 ? (
                <p className="text-sm text-ink-muted">No asset results in this view.</p>
              ) : (
                <Table label="Contribution by asset">
                  <thead>
                    <tr>
                      <Th>Instrument</Th>
                      <Th>Asset class</Th>
                      <Th numeric>Net P/L</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.byAsset.map((a) => (
                      <tr key={a.instrumentId}>
                        <Td className="font-medium">{a.symbol}</Td>
                        <Td>{ASSET_CLASS_LABELS[a.assetClass] ?? a.assetClass}</Td>
                        <Td numeric>
                          <Signed value={a.net}>{formatSignedMoney(a.net)}</Signed>
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Section>
          </div>

          <Section title="Trades">
            {data.trades.length === 0 ? (
              <p className="text-sm text-ink-muted">No trades in this view.</p>
            ) : (
              <Table label="Trades">
                <thead>
                  <tr>
                    <Th>Number</Th>
                    <Th>Strategy cycle</Th>
                    <Th>Opened</Th>
                    <Th>Closed</Th>
                    <Th>Legs</Th>
                    <Th numeric>Net P/L</Th>
                    <Th numeric>Return</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.trades.map((t) => (
                    <tr key={t.cycleId}>
                      <StrategyNumberCell number={t.strategyNumber} />
                      <Td>
                        <div className="font-medium">{t.strategyName}</div>
                        <div className="text-xs text-ink-muted">
                          Version {t.versionNo}, cycle {t.seq}
                        </div>
                      </Td>
                      <Td className="whitespace-nowrap text-content">{when(t.openedAt)}</Td>
                      <Td className="whitespace-nowrap text-content">
                        {t.closedAt ? when(t.closedAt) : <Badge tone="info">Open</Badge>}
                      </Td>
                      <Td>
                        <Legs trade={t} />
                      </Td>
                      <Td numeric>
                        <Signed value={t.net}>{formatSignedMoney(t.net)}</Signed>
                        {Number(t.fees) > 0 && (
                          <div className="text-xs text-ink-muted">
                            after {formatMoney(t.fees)} fees
                          </div>
                        )}
                      </Td>
                      <Td numeric>
                        <Signed value={t.returnPct}>{formatPct(t.returnPct, true)}</Signed>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
            <p className="text-xs text-ink-muted">
              One trade is one strategy cycle, Entry to Exit, with each leg&apos;s part. Realized
              results only; open lots count once they close.
            </p>
          </Section>

          <Section title="Open positions">
            {positions.length === 0 ? (
              <p className="text-sm text-ink-muted">No open positions.</p>
            ) : (
              <Table label="Open positions">
                <thead>
                  <tr>
                    <Th>Number</Th>
                    <Th>Strategy</Th>
                    <Th>Instrument</Th>
                    <Th>Account</Th>
                    <Th numeric>Quantity</Th>
                    <Th numeric>Average cost</Th>
                    <Th>Strategy status</Th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((p) => (
                    <tr key={`${p.runtimeId}-${p.instrumentId}`}>
                      <StrategyNumberCell number={p.strategyNumber} />
                      <Td className="font-medium">{p.strategyName}</Td>
                      <Td>{p.symbol}</Td>
                      <Td sortValue={p.accountName}>
                        <AccountLabel name={p.accountName} mode={p.accountMode} />
                      </Td>
                      <Td numeric>{p.quantity}</Td>
                      <Td numeric>{p.averageCost ? formatMoney(p.averageCost) : '—'}</Td>
                      <Td>
                        {p.runtimeStatus === 'running'
                          ? 'Running'
                          : p.runtimeStatus === 'paused'
                            ? 'Paused'
                            : 'Stopped'}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Section>

          <DataQuality summary={summary} when={when} />
        </>
      )}
    </div>
  );
}

/**
 * The headline figures in little space (N302): a strip of the numbers checked
 * first, then Returns / Risk / Trading as label and value lists, each value's
 * detail in grey beside it.
 */
export function HeadlineFigures({ layout }: { layout: PerformanceLayout }) {
  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-line bg-line sm:grid-cols-4">
        {layout.headline.map((t) => (
          <div key={t.label} className="bg-surface px-3 py-2">
            <dt className="text-xs text-ink-muted">{t.label}</dt>
            <dd className="text-lg text-content-strong">
              <TileValue tile={t} />
            </dd>
            {t.detail && <dd className="text-xs text-ink-muted">{t.detail}</dd>}
          </div>
        ))}
      </dl>
      <div className="grid gap-x-6 gap-y-3 sm:grid-cols-3">
        {layout.groups.map((g) => (
          <section key={g.title} aria-label={g.title}>
            <h3 className="text-xs font-semibold tracking-wide text-ink-muted uppercase">
              {g.title}
            </h3>
            <dl className="text-sm">
              {g.tiles.map((t) => (
                <div
                  key={t.label}
                  className="flex items-baseline justify-between gap-3 border-b border-line py-1 last:border-b-0"
                >
                  <dt className="text-ink">{t.label}</dt>
                  <dd className="flex flex-wrap items-baseline justify-end gap-x-1.5 text-right">
                    <span className="text-content-strong">
                      <TileValue tile={t} />
                    </span>
                    {t.detail && <span className="text-xs text-ink-muted">{t.detail}</span>}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </div>
  );
}
