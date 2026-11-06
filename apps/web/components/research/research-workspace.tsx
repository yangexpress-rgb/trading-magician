'use client';

import { ApiError, type InstrumentOptionDto, type PriceChartDto } from '@tm/contracts';
import {
  CHART_INTERVALS,
  CHART_RANGES,
  chartIntervalAllowed,
  defaultChartInterval,
  INDEX_BADGE,
  isIndicatorOnlyClass,
  type ChartInterval,
  type ChartRange,
} from '@tm/domain';
import { Alert, Badge, Card, cx } from '@tm/ui';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiClient } from '@/lib/api-client';
import { ASSET_CLASS_LABELS } from '@/lib/integration-text';
import {
  formatBarTime,
  formatChange,
  formatPrice,
  INTERVAL_LABELS,
  INTERVAL_LIMITS,
  RANGE_LABELS,
  RANGE_NAMES,
  summarize,
  toBars,
} from '@/lib/research-text';
import { CompanyPanel } from './company-panel';
import { PriceChart, type ChartStyle } from './price-chart';
import { StockPicker } from './stock-picker';

const POLL_MS = 700;
const GIVE_UP_MS = 45_000;

/** Every stock or ETF opens on its latest session: 5-minute bars, as a line. */
const OPENING_VIEW = { range: '1d', interval: '5m', style: 'line' } as const;
/** An index has daily bars only (CBOE end-of-day, v1.2 item 5): it opens on 5 years of them. */
const INDEX_VIEW = { range: '5y', interval: '1d', style: 'line' } as const;
const viewFor = (i: InstrumentOptionDto | undefined) =>
  i && isIndicatorOnlyClass(i.assetClass) ? INDEX_VIEW : OPENING_VIEW;

export interface ResearchSelection {
  instrumentId: string | null;
  range: ChartRange;
  interval: ChartInterval;
  style: ChartStyle;
}

/**
 * Quantitative Research, first tool (ADR 0029): pick a stock or ETF and see
 * its price history. The selection lives in the address so a chart can be
 * bookmarked or reloaded.
 */
export function ResearchWorkspace({
  instruments: initialInstruments,
  initial,
  canSearchMarket,
  companyFeed = null,
}: {
  instruments: InstrumentOptionDto[];
  initial: ResearchSelection;
  canSearchMarket: boolean;
  /** The company data feed in use, by name (ADR 0031); null when there is none. */
  companyFeed?: string | null;
}) {
  const router = useRouter();
  const [instruments, setInstruments] = useState(initialInstruments);
  const [sel, setSel] = useState<ResearchSelection>(initial);
  const [chart, setChart] = useState<PriceChartDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const selected = instruments.find((i) => i.id === sel.instrumentId) ?? null;
  /** An index: daily bars only, no company behind it (v1.2 item 5). */
  const dailyOnly = !!selected && isIndicatorOnlyClass(selected.assetClass);

  const update = useCallback(
    (patch: Partial<ResearchSelection>) => {
      setSel((cur) => {
        const next = { ...cur, ...patch };
        // Hourly bars only go back 3 months; a longer range falls back to daily.
        // Each range opens on bars it offers: a day on 5-minute bars, longer ranges on daily.
        if (patch.range && patch.range !== cur.range && !patch.interval) {
          next.interval =
            patch.range === '1d' ||
            cur.range === '1d' ||
            !chartIntervalAllowed(next.range, next.interval)
              ? defaultChartInterval(next.range)
              : next.interval;
        }
        const q = new URLSearchParams();
        if (next.instrumentId) q.set('instrument', next.instrumentId);
        q.set('range', next.range);
        q.set('interval', next.interval);
        if (next.style !== 'line') q.set('style', next.style);
        router.replace(`/research?${q.toString()}`, { scroll: false });
        return next;
      });
    },
    [router],
  );

  useEffect(() => () => clearTimeout(timer.current), []);

  // A bookmarked intraday view of an index: show its daily bars instead.
  useEffect(() => {
    if (dailyOnly && (sel.interval !== '1d' || sel.range === '1d'))
      update({ range: sel.range === '1d' ? INDEX_VIEW.range : sel.range, interval: '1d' });
  }, [dailyOnly, sel.interval, sel.range, update]);

  useEffect(() => {
    clearTimeout(timer.current);
    if (!sel.instrumentId) return;
    const mine = ++request.current;
    const stale = () => mine !== request.current;
    setLoading(true);
    setError(null);
    const deadline = Date.now() + GIVE_UP_MS;
    const settle = (c: PriceChartDto) => {
      if (stale()) return;
      if (c.status === 'pending') {
        if (Date.now() > deadline) {
          setLoading(false);
          setError('The prices are taking longer than expected. Try again in a minute.');
          return;
        }
        timer.current = setTimeout(() => {
          apiClient.research.getChart(c.id).then(settle, () => {
            if (stale()) return;
            setLoading(false);
            setError('Could not check on the chart. Try again.');
          });
        }, POLL_MS);
        return;
      }
      setLoading(false);
      if (c.status === 'failed') {
        setError(c.message ?? 'The prices could not be loaded.');
        setChart(null);
      } else setChart(c);
    };
    apiClient.research
      .chart({ instrumentId: sel.instrumentId, range: sel.range, interval: sel.interval })
      .then(settle, (err: unknown) => {
        if (stale()) return;
        setLoading(false);
        setError(err instanceof ApiError ? err.message : 'Could not load the prices.');
      });
  }, [sel.instrumentId, sel.range, sel.interval]);

  // Keep showing the previous chart while the next one loads, dimmed.
  const showing = chart;
  const bars = useMemo(() => toBars(showing?.bars ?? []), [showing]);
  const summary = summarize(bars);

  return (
    <div className="grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <aside className="space-y-4" aria-label="Choose a stock">
        <StockPicker
          instruments={instruments}
          selectedId={sel.instrumentId}
          onSelect={(instrumentId) =>
            update({ instrumentId, ...viewFor(instruments.find((i) => i.id === instrumentId)) })
          }
          canSearchMarket={canSearchMarket}
          onAdded={(found) => {
            setInstruments((cur) =>
              cur.some((i) => i.id === found.id)
                ? cur
                : [...cur, found].sort((a, b) => a.symbol.localeCompare(b.symbol)),
            );
            update({ instrumentId: found.id, ...viewFor(found) });
          }}
        />
      </aside>

      <div className="min-w-0 space-y-6">
        <section aria-labelledby="chart-heading" className="min-w-0">
          <Card>
            {!selected ? (
              <div className="py-16 text-center">
                <h2 id="chart-heading" className="text-lg font-semibold">
                  Pick a stock to see its prices
                </h2>
                <p className="mt-1 text-sm text-ink-muted">
                  Choose one from the list, or find another US stock or ETF by its symbol.
                </p>
              </div>
            ) : (
              <>
                <header className="mb-4 flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <h2
                      id="chart-heading"
                      className="flex flex-wrap items-baseline gap-x-2 text-lg"
                    >
                      <span className="font-semibold">{selected.symbol}</span>
                      <span className="truncate text-ink-muted">{selected.displayName}</span>
                      {dailyOnly && <Badge tone="warn">{INDEX_BADGE}</Badge>}
                    </h2>
                    <p className="text-xs text-ink-muted">
                      {ASSET_CLASS_LABELS[selected.assetClass] ?? selected.assetClass} ·{' '}
                      {selected.venue === 'DEMO'
                        ? 'Demo instrument, simulated prices'
                        : selected.venue}
                    </p>
                  </div>
                  {summary && showing?.instrument.id === selected.id && (
                    <div className="text-right tabular-nums" data-testid="chart-summary">
                      <p className="text-2xl font-semibold">{formatPrice(summary.last)}</p>
                      <p className="text-sm">
                        <span className="sr-only">Change over {RANGE_NAMES[showing.range]}: </span>
                        <span className={summary.change < 0 ? 'text-danger' : 'text-ok'}>
                          {summary.change < 0 ? '▼' : '▲'}{' '}
                          {formatChange(summary.change, summary.changePct)}
                        </span>{' '}
                        <span className="text-ink-muted">{RANGE_NAMES[showing.range]}</span>
                      </p>
                    </div>
                  )}
                </header>

                <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
                  <Segmented
                    label="Range"
                    value={sel.range}
                    options={CHART_RANGES.map((r) => ({
                      value: r,
                      label: RANGE_LABELS[r],
                      title: RANGE_NAMES[r],
                      // One daily bar is not a chart.
                      disabled: dailyOnly && r === '1d',
                    }))}
                    onChange={(range) => update({ range })}
                  />
                  <Segmented
                    label="Bars"
                    value={sel.interval}
                    options={CHART_INTERVALS.map((i) => ({
                      value: i,
                      label: INTERVAL_LABELS[i],
                      disabled: !chartIntervalAllowed(sel.range, i) || (dailyOnly && i !== '1d'),
                      title:
                        dailyOnly && i !== '1d'
                          ? 'CBOE gives index history as daily bars only'
                          : chartIntervalAllowed(sel.range, i)
                            ? undefined
                            : INTERVAL_LIMITS[i],
                    }))}
                    onChange={(interval) => update({ interval })}
                  />
                  <Segmented
                    label="Chart"
                    value={sel.style}
                    options={[
                      { value: 'line', label: 'Line' },
                      { value: 'candles', label: 'Candles' },
                    ]}
                    onChange={(style) => update({ style })}
                  />
                  <p role="status" aria-live="polite" className="text-sm text-ink-muted">
                    {loading ? `Loading ${selected.symbol} prices…` : ''}
                  </p>
                </div>

                {error && <Alert>{error}</Alert>}

                {showing && bars.length > 0 ? (
                  <PriceChart
                    symbol={showing.instrument.symbol}
                    bars={bars}
                    interval={showing.interval}
                    range={showing.range}
                    style={sel.style}
                    dimmed={loading || showing.instrument.id !== selected.id}
                  />
                ) : (
                  showing &&
                  !loading &&
                  !error && (
                    <p className="py-12 text-center text-sm text-ink-muted">
                      No prices for {showing.instrument.symbol} in this range yet.
                    </p>
                  )
                )}

                {showing && showing.instrument.id === selected.id && (
                  <footer className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
                    {showing.source && <Badge>{`Prices from ${showing.source}`}</Badge>}
                    <span>
                      {INTERVAL_LABELS[showing.interval]} bars, regular session, split-adjusted.
                      {summary && ` Last bar ${formatBarTime(summary.lastAt, showing.interval)}.`}
                    </span>
                    {showing.warnings.map((w) => (
                      <span key={w} className="basis-full">
                        {w}
                      </span>
                    ))}
                  </footer>
                )}
              </>
            )}
          </Card>
        </section>
        {selected && !dailyOnly && (
          <CompanyPanel
            instrument={selected}
            price={summary && showing?.instrument.id === selected.id ? summary.last : null}
            companyFeed={companyFeed}
          />
        )}
      </div>
    </div>
  );
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; title?: string | undefined; disabled?: boolean }[];
  onChange: (value: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex items-center gap-2">
      <span className="text-xs font-medium text-ink-muted">{label}</span>
      <div className="inline-flex rounded-md border border-line bg-surface-2 p-0.5">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={o.value === value}
            disabled={o.disabled}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={cx(
              'h-7 rounded px-2.5 text-sm tabular-nums disabled:cursor-not-allowed disabled:opacity-40',
              o.value === value ? 'bg-surface font-semibold text-ink shadow-sm' : 'text-ink-muted',
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
