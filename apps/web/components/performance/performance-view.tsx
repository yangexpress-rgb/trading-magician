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
  Stat,
  Table,
  Td,
  TextField,
  Th,
} from '@tm/ui';
import Link from 'next/link';
import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import { LineChart } from '@/components/line-chart';
import { apiClient } from '@/lib/api-client';
import { formatDay, formatMoney, formatPct, formatSignedMoney } from '@/lib/backtest-text';
import { subscribeLive } from '@/lib/live-events';
import {
  ASSET_CLASS_LABELS,
  assetChoices,
  describePositionDifference,
  performanceSearch,
  performanceTiles,
  type PerformanceFilters,
} from '@/lib/performance-text';
import { bare } from '@/lib/units';

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
          {l.averageClose
            ? `, closed ${l.closed} at ${formatMoney(l.averageClose)}`
            : ', open'}{' '}
          <span className="text-content">({formatSignedMoney(l.net)})</span>
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
                <Th numeric>App equity $</Th>
                <Th numeric>Broker equity $</Th>
                <Th>Holdings</Th>
              </tr>
            </thead>
            <tbody>
              {q.differences.map((d) => (
                <tr key={`${d.accountId}-${d.sessionDate}`}>
                  <Td className="whitespace-nowrap text-content">{formatDay(d.sessionDate)}</Td>
                  <Td>{d.accountName}</Td>
                  <Td numeric>{d.appEquity ? bare(formatMoney(d.appEquity)) : '—'}</Td>
                  <Td numeric>
                    {d.brokerEquity ? bare(formatMoney(d.brokerEquity)) : 'Not reported'}
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
  accounts: { id: string; name: string }[];
  strategies: { id: string; name: string; versions: { id: string; versionNo: number }[] }[];
}) {
  const [filters, setFilters] = useState<PerformanceFilters>(initialFilters);
  const { data, error } = usePerformance(filters);
  const set = (patch: Partial<PerformanceFilters>) => setFilters((f) => ({ ...f, ...patch }));

  useEffect(() => {
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${performanceSearch(filters)}`,
    );
  }, [filters]);

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
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
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
              {s.name}
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
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {performanceTiles(summary).map((t) => (
                <Stat
                  key={t.label}
                  className="rounded-md border border-line p-3"
                  label={t.label}
                  value={t.value}
                  comparison={t.detail}
                />
              ))}
            </dl>
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
                      <Th>Strategy</Th>
                      <Th numeric>Closed trades</Th>
                      <Th numeric>Net P/L $</Th>
                      <Th numeric>Return on peak capital %</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.byStrategy.map((s) => (
                      <tr key={s.strategyId}>
                        <Td className="font-medium">{s.strategyName}</Td>
                        <Td numeric>{s.closedTrades}</Td>
                        <Td numeric>{bare(formatSignedMoney(s.net))}</Td>
                        <Td numeric>
                          {bare(formatPct(s.returnOnPeakCapitalPct, true))}
                          <div className="text-xs text-ink-muted">
                            of {formatMoney(s.peakCapital)}
                          </div>
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
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
                      <Th numeric>Net P/L $</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.byAsset.map((a) => (
                      <tr key={a.instrumentId}>
                        <Td className="font-medium">{a.symbol}</Td>
                        <Td>{ASSET_CLASS_LABELS[a.assetClass] ?? a.assetClass}</Td>
                        <Td numeric>{bare(formatSignedMoney(a.net))}</Td>
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
                    <Th>Strategy cycle</Th>
                    <Th>Opened</Th>
                    <Th>Closed</Th>
                    <Th>Legs</Th>
                    <Th numeric>Net P/L $</Th>
                    <Th numeric>Return %</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.trades.map((t) => (
                    <tr key={t.cycleId}>
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
                        {bare(formatSignedMoney(t.net))}
                        {Number(t.fees) > 0 && (
                          <div className="text-xs text-ink-muted">
                            after {formatMoney(t.fees)} fees
                          </div>
                        )}
                      </Td>
                      <Td numeric>{bare(formatPct(t.returnPct, true))}</Td>
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
                    <Th>Strategy</Th>
                    <Th>Instrument</Th>
                    <Th>Account</Th>
                    <Th numeric>Quantity</Th>
                    <Th numeric>Average cost $</Th>
                    <Th>Strategy status</Th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((p) => (
                    <tr key={`${p.runtimeId}-${p.instrumentId}`}>
                      <Td className="font-medium">{p.strategyName}</Td>
                      <Td>{p.symbol}</Td>
                      <Td>{p.accountName}</Td>
                      <Td numeric>{p.quantity}</Td>
                      <Td numeric>{p.averageCost ? bare(formatMoney(p.averageCost)) : '—'}</Td>
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
