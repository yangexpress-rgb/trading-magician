'use client';

import type { InstrumentOptionDto } from '@tm/contracts';
import {
  CHART_INTERVALS,
  CHART_RANGES,
  chartIntervalAllowed,
  defaultChartInterval,
  INDEX_BADGE,
  isIndicatorOnlyClass,
  nyDate,
  stepChartEnd,
  type ChartInterval,
  type ConePoint,
  type ChartRange,
} from '@tm/domain';
import { Alert, Badge, Card, cx } from '@tm/ui';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MAX_COMPARE } from '@/lib/chart-history';
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
  type Bar,
} from '@/lib/research-text';
import { CompanyPanel } from './company-panel';
import { ComparePicker } from './compare-picker';
import { EarningsPanel } from './earnings-panel';
import { OptionsPanel } from './options-panel';
import { PriceChart, type ChartStyle, type ComparedSeries } from './price-chart';
import { StockPicker } from './stock-picker';
import { useChartHistory } from './use-chart-history';

/** Every stock or ETF opens on its latest session: 5-minute bars, as candles (N203). */
const OPENING_VIEW = { range: '1d', interval: '5m', style: 'candles' } as const;
/** An index has daily bars only (CBOE end-of-day, v1.2 item 5): it opens on 5 years of them. */
const INDEX_VIEW = { range: '5y', interval: '1d', style: 'line' } as const;
const viewFor = (i: InstrumentOptionDto | undefined) =>
  i && isIndicatorOnlyClass(i.assetClass) ? INDEX_VIEW : OPENING_VIEW;

export interface ResearchSelection {
  instrumentId: string | null;
  range: ChartRange;
  interval: ChartInterval;
  style: ChartStyle;
  /** New York date the chart ends on (N196); null for today. */
  end: string | null;
  /** Other instruments drawn on the same chart (N198), in the order added. */
  compare: string[];
}

const DAY_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});
const formatDay = (date: string) => DAY_FMT.format(new Date(`${date}T12:00:00Z`));

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
  optionsFeed = null,
}: {
  instruments: InstrumentOptionDto[];
  initial: ResearchSelection;
  canSearchMarket: boolean;
  /** The company data feed in use, by name (ADR 0031); null when there is none. */
  companyFeed?: string | null;
  /** The options feed in use, by name (ADR 0048); null when there is none. */
  optionsFeed?: string | null;
}) {
  const router = useRouter();
  const [instruments, setInstruments] = useState(initialInstruments);
  const [sel, setSel] = useState<ResearchSelection>(initial);
  const [cone, setCone] = useState<ConePoint[] | null>(null);
  const [showCone, setShowCone] = useState(true);
  const selected = instruments.find((i) => i.id === sel.instrumentId) ?? null;
  /** An index: daily bars only, no company behind it (v1.2 item 5). */
  const dailyOnly = !!selected && isIndicatorOnlyClass(selected.assetClass);

  const update = useCallback((patch: Partial<ResearchSelection>) => {
    setSel((cur) => {
      const next = { ...cur, ...patch };
      // Hourly bars only go back 3 months; a longer range falls back to daily.
      // Each range opens on bars it offers: a day on 5-minute bars, a week on hourly (N203),
      // longer ranges on daily.
      const ownBars = (r: ChartRange) => r === '1d' || r === '1w';
      if (patch.range && patch.range !== cur.range && !patch.interval) {
        next.interval =
          ownBars(patch.range) ||
          ownBars(cur.range) ||
          !chartIntervalAllowed(next.range, next.interval)
            ? defaultChartInterval(next.range)
            : next.interval;
      }
      return next;
    });
    changed.current = true;
  }, []);

  // The URL follows the view once the person changes it. Done in an effect, not in the
  // state updater, which React may run while rendering (that updated the Router mid-render).
  const changed = useRef(false);
  useEffect(() => {
    if (!changed.current) return;
    const q = new URLSearchParams();
    if (sel.instrumentId) q.set('instrument', sel.instrumentId);
    q.set('range', sel.range);
    q.set('interval', sel.interval);
    if (sel.style !== 'candles') q.set('style', sel.style);
    if (sel.end) q.set('date', sel.end);
    if (sel.compare.length) q.set('compare', sel.compare.join(','));
    router.replace(`/research?${q.toString()}`, { scroll: false });
  }, [router, sel.instrumentId, sel.range, sel.interval, sel.style, sel.end, sel.compare]);

  // A bookmarked intraday view of an index: show its daily bars instead.
  useEffect(() => {
    if (dailyOnly && (sel.interval !== '1d' || sel.range === '1d'))
      update({ range: sel.range === '1d' ? INDEX_VIEW.range : sel.range, interval: '1d' });
  }, [dailyOnly, sel.interval, sel.range, update]);

  const history = useChartHistory({
    instrumentId: sel.instrumentId,
    range: sel.range,
    interval: sel.interval,
    end: sel.end,
    compare: sel.compare,
  });
  const { chart, loading, error } = history;

  // Keep showing the previous chart, dimmed, while another range or bar size of the same
  // instrument loads. Another instrument's chart is never shown under this one's name, even
  // while the new chart loads or after it failed (N153).
  const showing = chart && selected && chart.instrument.id === selected.id ? chart : null;
  const bars = useMemo(
    () => (showing && selected ? (history.series[selected.id]?.bars ?? []) : []),
    [showing, selected, history.series],
  );

  // Each compared symbol keeps its colour while others come and go (N198).
  const slots = useRef(new Map<string, number>());
  const compared: ComparedSeries[] = useMemo(() => {
    for (const id of [...slots.current.keys()]) {
      if (!sel.compare.includes(id)) slots.current.delete(id);
    }
    return sel.compare.flatMap((id) => {
      const inst = instruments.find((i) => i.id === id);
      if (!inst || id === sel.instrumentId) return [];
      if (!slots.current.has(id)) {
        const used = new Set(slots.current.values());
        slots.current.set(id, [2, 3, 4, 5].find((n) => !used.has(n)) ?? 5);
      }
      const st = history.series[id];
      return [
        {
          id,
          symbol: inst.symbol,
          bars: st?.bars ?? [],
          slot: slots.current.get(id) ?? 5,
          loading: st?.loading ?? true,
          error: st?.error ?? null,
        },
      ];
    });
  }, [sel.compare, sel.instrumentId, instruments, history.series]);

  // The header follows the bars in view, which the person can scroll and zoom (N197).
  const [inView, setInView] = useState<{ from: number; to: number; moved: boolean } | null>(null);
  const onViewChange = useCallback(
    (a: Bar, b: Bar, moved: boolean) => setInView({ from: a.t, to: b.t, moved }),
    [],
  );
  const viewBars = useMemo(
    () => (inView ? bars.filter((b) => b.t >= inView.from && b.t <= inView.to) : bars),
    [bars, inView],
  );
  const summary = summarize(viewBars.length ? viewBars : bars);
  const spanLabel =
    inView?.moved && summary && showing
      ? 'in view'
      : showing
        ? sel.end
          ? `${RANGE_NAMES[showing.range]} to ${formatDay(showing.to)}`
          : RANGE_NAMES[showing.range]
        : '';
  const today = nyDate(new Date());

  const [picking, setPicking] = useState(false);
  const pickerBox = useRef<HTMLDivElement>(null);
  const pickerPanel = useRef<HTMLDivElement>(null);
  // Opening the picker puts the cursor in its search box.
  useEffect(() => {
    if (picking) pickerPanel.current?.querySelector<HTMLInputElement>('input')?.focus();
  }, [picking]);
  // A click outside the open picker closes it.
  useEffect(() => {
    if (!picking) return;
    const onDown = (e: MouseEvent) => {
      if (pickerBox.current && !pickerBox.current.contains(e.target as Node)) setPicking(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [picking]);

  // The stock picker opens over the chart from its title (N201): no card beside the chart.
  const picker = (
    <StockPicker
      instruments={instruments}
      selectedId={sel.instrumentId}
      onSelect={(instrumentId) => {
        setPicking(false);
        update({
          instrumentId,
          ...viewFor(instruments.find((i) => i.id === instrumentId)),
          end: null,
          compare: sel.compare.filter((c) => c !== instrumentId),
        });
      }}
      canSearchMarket={canSearchMarket}
      onAdded={(found) => {
        setPicking(false);
        setInstruments((cur) =>
          cur.some((i) => i.id === found.id)
            ? cur
            : [...cur, found].sort((a, b) => a.symbol.localeCompare(b.symbol)),
        );
        update({
          instrumentId: found.id,
          ...viewFor(found),
          end: null,
          compare: sel.compare.filter((c) => c !== found.id),
        });
      }}
    />
  );

  /** The Date controls (N196), on one row with the bar readout (N204). */
  const dateRow = (
    <div role="group" aria-label="Date" className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium text-ink-muted">Date</span>
      <button
        type="button"
        className="h-7 rounded-md border border-line bg-surface-2 px-2 text-sm"
        aria-label={`Previous ${sel.range === '1d' ? 'trading day' : RANGE_NAMES[sel.range]}`}
        title={`Previous ${sel.range === '1d' ? 'trading day' : RANGE_NAMES[sel.range]}`}
        onClick={() => update({ end: stepChartEnd(sel.range, sel.end, -1, new Date()) })}
      >
        ‹
      </button>
      <label className="sr-only" htmlFor="chart-end-date">
        Chart ends on
      </label>
      <input
        id="chart-end-date"
        type="date"
        max={today}
        min="2000-01-01"
        value={sel.end ?? today}
        onChange={(e) => {
          const v = e.target.value;
          if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return;
          update({ end: v >= today ? null : v });
        }}
        className="h-7 rounded-md border border-line bg-surface px-2 text-sm tabular-nums"
      />
      <button
        type="button"
        className="h-7 rounded-md border border-line bg-surface-2 px-2 text-sm disabled:cursor-not-allowed disabled:opacity-40"
        aria-label={`Next ${sel.range === '1d' ? 'trading day' : RANGE_NAMES[sel.range]}`}
        title={`Next ${sel.range === '1d' ? 'trading day' : RANGE_NAMES[sel.range]}`}
        disabled={!sel.end}
        onClick={() => update({ end: stepChartEnd(sel.range, sel.end, 1, new Date()) })}
      >
        ›
      </button>
      <button
        type="button"
        className="h-7 rounded-md border border-line bg-surface-2 px-2 text-sm disabled:cursor-not-allowed disabled:opacity-40"
        disabled={!sel.end}
        onClick={() => update({ end: null })}
      >
        Latest
      </button>
      <span className="text-xs text-ink-muted">
        {sel.end
          ? `${RANGE_NAMES[sel.range]} ending ${formatDay(sel.end)}`
          : `${RANGE_NAMES[sel.range]} to today`}
      </span>
    </div>
  );
  return (
    <div className="min-w-0">
      <div className="min-w-0 space-y-6">
        <section aria-labelledby="chart-heading" className="min-w-0">
          <Card>
            {!selected ? (
              <div className="mx-auto max-w-md py-8">
                <h2 id="chart-heading" className="mb-3 text-center text-lg font-semibold">
                  Pick a stock to see its prices
                </h2>
                {picker}
              </div>
            ) : (
              <>
                <header className="mb-4 flex flex-wrap items-start justify-between gap-4">
                  <div ref={pickerBox} className="relative min-w-0">
                    <h2
                      id="chart-heading"
                      className="flex flex-wrap items-baseline gap-x-2 text-lg"
                    >
                      <span
                        className="cursor-pointer rounded font-semibold select-none hover:bg-surface-2"
                        title="Double-click to chart another stock"
                        onDoubleClick={() => setPicking(true)}
                        data-testid="chart-symbol"
                      >
                        {selected.symbol}
                      </span>
                      <span className="truncate text-ink-muted">{selected.displayName}</span>
                      {dailyOnly && <Badge tone="warn">{INDEX_BADGE}</Badge>}
                      <button
                        type="button"
                        aria-expanded={picking}
                        aria-label="Change stock"
                        title="Change stock"
                        onClick={() => setPicking((p) => !p)}
                        className="self-center rounded px-1 text-sm text-ink-muted hover:bg-surface-2 hover:text-ink"
                      >
                        ▾
                      </button>
                    </h2>
                    {/* Kept mounted while hidden, so a search still running finishes. */}
                    {
                      <div
                        ref={pickerPanel}
                        role="dialog"
                        aria-label="Change stock"
                        hidden={!picking}
                        className="absolute top-full left-0 z-30 mt-2 w-[24rem] max-w-[calc(100vw-2.5rem)] rounded-lg shadow-lg"
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') setPicking(false);
                        }}
                      >
                        {picker}
                      </div>
                    }
                    <p className="text-xs text-ink-muted">
                      {ASSET_CLASS_LABELS[selected.assetClass] ?? selected.assetClass} ·{' '}
                      {selected.venue === 'DEMO'
                        ? 'Demo instrument, simulated prices'
                        : selected.venue}
                    </p>
                  </div>
                  {summary && showing && (
                    <div className="text-right tabular-nums" data-testid="chart-summary">
                      <p className="text-2xl font-semibold">{formatPrice(summary.last)}</p>
                      <p className="text-sm">
                        <span className="sr-only">Change over {spanLabel}: </span>
                        <span className={summary.change < 0 ? 'text-danger' : 'text-ok'}>
                          {summary.change < 0 ? '▼' : '▲'}{' '}
                          {formatChange(summary.change, summary.changePct)}
                        </span>{' '}
                        <span className="text-ink-muted">{spanLabel}</span>
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
                  <ComparePicker
                    instruments={instruments}
                    mainId={selected.id}
                    compared={compared}
                    canSearchMarket={canSearchMarket}
                    onAdd={(id) => update({ compare: [...sel.compare, id].slice(0, MAX_COMPARE) })}
                    onRemove={(id) => update({ compare: sel.compare.filter((c) => c !== id) })}
                    onFound={(found) => {
                      setInstruments((cur) =>
                        cur.some((i) => i.id === found.id)
                          ? cur
                          : [...cur, found].sort((a, b) => a.symbol.localeCompare(b.symbol)),
                      );
                      if (found.id !== selected.id && !sel.compare.includes(found.id))
                        update({ compare: [...sel.compare, found.id].slice(0, MAX_COMPARE) });
                    }}
                  />
                  <p role="status" aria-live="polite" className="text-sm text-ink-muted">
                    {loading ? `Loading ${selected.symbol} prices…` : ''}
                  </p>
                </div>

                {!(showing && bars.length > 0) && <div className="mb-3">{dateRow}</div>}

                {error && <Alert>{error}</Alert>}

                {showing && bars.length > 0 ? (
                  <PriceChart
                    symbol={showing.instrument.symbol}
                    bars={bars}
                    interval={showing.interval}
                    range={showing.range}
                    style={sel.style}
                    leading={dateRow}
                    dimmed={loading}
                    cone={showCone && !sel.end ? cone : null}
                    compared={compared}
                    openingCount={history.openingCount}
                    resetKey={showing.id}
                    extending={history.extending}
                    atStart={history.atStart}
                    atLatest={history.atLatest}
                    onNeedEarlier={history.loadEarlier}
                    onNeedLater={history.loadLater}
                    onViewChange={onViewChange}
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

                {showing && (
                  <footer className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
                    {showing.source && <Badge>{`Prices from ${showing.source}`}</Badge>}
                    <span>
                      {INTERVAL_LABELS[showing.interval]} bars, regular session, split-adjusted.
                      {summary && ` Last bar ${formatBarTime(summary.lastAt, showing.interval)}.`}
                      {sel.compare.length > 0 &&
                        ' Compared symbols are drawn as percent change from the first bar in view.'}
                    </span>
                    {cone && (
                      <span className="flex items-center gap-2">
                        <label className="flex items-center gap-1">
                          <input
                            type="checkbox"
                            checked={showCone}
                            onChange={(e) => setShowCone(e.target.checked)}
                          />
                          Expected move from options
                        </label>
                        {showCone && showing.interval !== '1d' && (
                          <button
                            type="button"
                            className="underline"
                            onClick={() => update({ range: '3m', interval: '1d' })}
                          >
                            Show it on 3 months of daily bars
                          </button>
                        )}
                      </span>
                    )}
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
          <OptionsPanel instrument={selected} optionsFeed={optionsFeed} onCone={setCone} />
        )}
        {selected && !dailyOnly && <EarningsPanel instrument={selected} />}
        {selected && !dailyOnly && (
          <CompanyPanel
            instrument={selected}
            price={showing && !sel.end ? (bars.at(-1)?.close ?? null) : null}
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
