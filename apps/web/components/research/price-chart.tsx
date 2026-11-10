'use client';

import {
  nyDate,
  tradingDaysBetween,
  type ChartInterval,
  type ChartRange,
  type ConePoint,
} from '@tm/domain';
import { Table, Td, Th } from '@tm/ui';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  alignBars,
  axisScaleFor,
  brokenPath,
  formatPercent,
  panShortfall,
  panView,
  percentFromFirst,
  viewIndexes,
  zoomView,
  type ChartView,
} from '@/lib/chart-history';
import {
  describeChart,
  formatAxisTime,
  formatBarTime,
  formatPrice,
  formatVolume,
  niceTicks,
  timeTickIndexes,
  type Bar,
} from '@/lib/research-text';
import { bare } from '@/lib/units';

export type ChartStyle = 'line' | 'candles';

/** Another symbol drawn on the same chart (N196), in its fixed colour slot (2–5). */
export interface ComparedSeries {
  id: string;
  symbol: string;
  bars: readonly Bar[];
  slot: number;
  loading: boolean;
  error: string | null;
}

const SERIES_STROKE = [
  'stroke-series-1',
  'stroke-series-1',
  'stroke-series-2',
  'stroke-series-3',
  'stroke-series-4',
  'stroke-series-5',
];
export const SERIES_BG = [
  'bg-series-1',
  'bg-series-1',
  'bg-series-2',
  'bg-series-3',
  'bg-series-4',
  'bg-series-5',
];
const SERIES_FILL = [
  'fill-series-1',
  'fill-series-1',
  'fill-series-2',
  'fill-series-3',
  'fill-series-4',
  'fill-series-5',
];

const PRICE_H = 300;
const VOLUME_H = 72;
const GAP = 12;
const AXIS_H = 22;
const RIGHT = 72;
const LEFT = 4;
const TOP = 8;
const HEIGHT = TOP + PRICE_H + GAP + VOLUME_H + AXIS_H;
/** A drag shorter than this is a tap that pins the crosshair, not a scroll. */
const DRAG_PX = 4;

/**
 * An instrument's prices over time (ADR 0029): a price pane (closing line or
 * candles) above a volume pane on the same time axis, with a crosshair that
 * follows the pointer or the arrow keys, and every value also in a table.
 * Bars are spaced evenly, so nights, weekends and holidays leave no gaps.
 *
 * The chart scrolls through time (N195): drag it, swipe sideways, or use the
 * buttons; older or newer bars are fetched when the view nears the end of
 * what is loaded. Ctrl or ⌘ with the wheel, a pinch, or the buttons zoom.
 * With other symbols to compare (N196), every line shows its percent change
 * from the left edge of the view.
 */
export function PriceChart({
  symbol,
  bars,
  interval,
  range,
  style,
  dimmed = false,
  cone = null,
  compared = [],
  openingCount,
  resetKey,
  extending = null,
  atStart = true,
  atLatest = true,
  onNeedEarlier,
  onNeedLater,
  onViewChange,
}: {
  symbol: string;
  bars: readonly Bar[];
  interval: ChartInterval;
  range: ChartRange;
  style: ChartStyle;
  dimmed?: boolean;
  /**
   * The expected-move cone from the options panel (ADR 0048), drawn to the
   * right of the last bar on daily charts only: one slot per trading day ahead.
   */
  cone?: readonly ConePoint[] | null;
  compared?: readonly ComparedSeries[];
  /** Bars in view when the chart opens: what the chosen range holds. */
  openingCount?: number;
  /** Changes when the chart starts over, which puts the view back to its opening. */
  resetKey?: string;
  extending?: 'earlier' | 'later' | null;
  atStart?: boolean;
  atLatest?: boolean;
  onNeedEarlier?: () => void;
  onNeedLater?: () => void;
  /** The bars in view, and whether the person moved or zoomed away from the opening view. */
  onViewChange?: (first: Bar, last: Bar, moved: boolean) => void;
}) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(800);
  const [active, setActive] = useState<number | null>(null);
  const opening = useCallback(
    (): ChartView => ({
      right: bars.at(-1)?.t ?? 0,
      count: Math.max(1, openingCount || bars.length),
    }),
    [bars, openingCount],
  );
  const [view, setView] = useState<ChartView>(opening);
  /** The person has scrolled or zoomed since the chart opened. */
  const [moved, setMoved] = useState(false);
  const drag = useRef<{ x: number; view: ChartView; panning: boolean } | null>(null);
  const barsRef = useRef(bars);
  barsRef.current = bars;
  /** Bars of a pan back still to make once older bars are loaded. */
  const owed = useRef(0);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(280, Math.round(entry.contentRect.width)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // A new chart opens on its chosen range, without a pinned crosshair.
  const openingRef = useRef(opening);
  openingRef.current = opening;
  useEffect(() => {
    setView(openingRef.current());
    owed.current = 0;
    setMoved(false);
    setActive(null);
  }, [resetKey]);

  const { first, last } = viewIndexes(bars, view);
  const vis = useMemo(() => bars.slice(first, last + 1), [bars, first, last]);
  const atNewest = last === bars.length - 1;
  const comparing = compared.length > 0;

  // Fetch older or newer bars once the person moves within a screen of either end (N195).
  useEffect(() => {
    if (!moved || extending) return;
    if (first < vis.length && !atStart) onNeedEarlier?.();
    else if (bars.length - 1 - last < vis.length && !atLatest) onNeedLater?.();
  }, [
    moved,
    extending,
    first,
    last,
    vis.length,
    bars.length,
    atStart,
    atLatest,
    onNeedEarlier,
    onNeedLater,
  ]);

  useEffect(() => {
    const a = vis[0];
    const b = vis.at(-1);
    if (a && b) onViewChange?.(a, b, moved);
  }, [vis, moved, onViewChange]);

  // A button pan back past the loaded bars finishes once the older bars arrive.
  const oldest = bars[0]?.t;
  useEffect(() => {
    if (owed.current >= 0) return;
    const delta = owed.current;
    owed.current = 0;
    setView((v) => panView(barsRef.current, v, delta));
  }, [oldest]);
  const panBy = (delta: number) => {
    owed.current = panShortfall(bars, view, delta);
    move((v) => panView(bars, v, delta));
  };

  const move = useCallback((next: (v: ChartView) => ChartView) => {
    setView((v) => next(v));
    setMoved(true);
  }, []);

  const plotW = width - LEFT - RIGHT;
  // The cone starts at the last bar's close and runs one slot per trading day after the
  // chain's day, as percentage moves, so a chain a few minutes newer than the bars still fits.
  // It shows only with the newest bar in view, and not while comparing percent changes.
  const conePts = useMemo(() => {
    const lastBar = vis.at(-1);
    const start = cone?.[0];
    if (!cone || !start || cone.length < 2 || interval !== '1d' || !lastBar || !atNewest)
      return null;
    if (comparing) return null;
    return cone.map((p) => ({
      ...p,
      ahead: tradingDaysBetween(start.date, p.date),
      upper: lastBar.close * (p.upper / start.upper),
      lower: lastBar.close * (p.lower / start.lower),
    }));
  }, [cone, vis, interval, atNewest, comparing]);
  const extra = conePts ? Math.max(0, ...conePts.map((p) => p.ahead)) : 0;

  /** Compared symbols lined up with the main one's bars in view, as percent changes. */
  const lines = useMemo(() => {
    if (!comparing) return [];
    return compared.map((c) => {
      const aligned = alignBars(vis, c.bars);
      return { ...c, aligned, ...percentFromFirst(aligned) };
    });
  }, [compared, comparing, vis]);
  const mainPct = useMemo(() => percentFromFirst(vis), [vis]);
  const base = mainPct.base;
  /** A main-symbol price as plotted: itself, or its percent change while comparing. */
  const val = useCallback(
    (v: number) => (comparing && base ? (v / base - 1) * 100 : v),
    [comparing, base],
  );

  const geo = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    let maxVol = 0;
    for (const b of vis) {
      const l = val(style === 'candles' ? b.low : b.close);
      const h = val(style === 'candles' ? b.high : b.close);
      if (l < lo) lo = l;
      if (h > hi) hi = h;
      if (b.volume > maxVol) maxVol = b.volume;
    }
    for (const line of lines) {
      for (const p of line.pct) {
        if (p === null) continue;
        if (p < lo) lo = p;
        if (p > hi) hi = p;
      }
    }
    for (const p of conePts ?? []) {
      if (p.lower < lo) lo = p.lower;
      if (p.upper > hi) hi = p.upper;
    }
    const ticks = niceTicks(lo, hi, 5);
    const min = ticks[0] ?? lo;
    const max = ticks.at(-1) ?? hi;
    const step = plotW / Math.max(1, vis.length + extra);
    const x = (i: number) => LEFT + step * (i + 0.5);
    const y = (v: number) => TOP + PRICE_H - ((v - min) / (max - min || 1)) * PRICE_H;
    const volTop = TOP + PRICE_H + GAP;
    const vy = (v: number) => volTop + VOLUME_H - (maxVol ? (v / maxVol) * VOLUME_H : 0);
    return { ticks, step, x, y, vy, volTop, maxVol };
  }, [vis, lines, plotW, style, conePts, extra, val]);

  const linePath = useMemo(
    () =>
      vis
        .map(
          (b, i) =>
            `${i === 0 ? 'M' : 'L'}${geo.x(i).toFixed(1)},${geo.y(val(b.close)).toFixed(1)}`,
        )
        .join(''),
    [vis, geo, val],
  );

  // Wheel and trackpad: a sideways swipe or Shift+wheel scrolls through time; Ctrl or ⌘
  // with the wheel (a trackpad pinch) zooms. A plain wheel still scrolls the page.
  const stepRef = useRef(geo.step);
  stepRef.current = geo.step;
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const all = barsRef.current;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        move((v) => zoomView(all, v, Math.exp(e.deltaY * 0.01)));
        return;
      }
      const sideways = e.shiftKey ? e.deltaY || e.deltaX : e.deltaX;
      if (Math.abs(sideways) < 1 || (!e.shiftKey && Math.abs(e.deltaX) < Math.abs(e.deltaY)))
        return;
      e.preventDefault();
      move((v) => panView(all, v, sideways / Math.max(1, stepRef.current)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [move]);

  const summary = describeChart(symbol, vis, range, interval, moved);
  const shown = active ?? vis.length - 1;
  const bar = vis[shown];
  const bodyW = Math.max(1, Math.min(12, geo.step * 0.7));
  const volW = Math.max(1, Math.min(12, geo.step - 2));

  function indexAt(clientX: number, el: Element) {
    const rect = el.getBoundingClientRect();
    const px = ((clientX - rect.left) / rect.width) * width;
    const i = Math.floor((px - LEFT) / geo.step);
    // The cone's slots have no bar: the readout stays on the last one.
    return Math.max(0, Math.min(vis.length - 1, i));
  }

  function pxPerScreenPx(el: Element) {
    const rect = el.getBoundingClientRect();
    return rect.width ? width / rect.width : 1;
  }

  function onKey(e: React.KeyboardEvent) {
    const lastIdx = vis.length - 1;
    const cur = active ?? lastIdx;
    const jump = Math.max(1, Math.round(vis.length / 10));
    if (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_') {
      e.preventDefault();
      move((v) => zoomView(bars, v, e.key === '+' || e.key === '=' ? 1 / 1.5 : 1.5));
      return;
    }
    // At either edge the arrow keys keep going: the chart scrolls under the crosshair.
    if (e.key === 'ArrowLeft' && cur === 0 && first > 0) {
      e.preventDefault();
      move((v) => panView(bars, v, -1));
      setActive(0);
      return;
    }
    if (e.key === 'ArrowRight' && cur === lastIdx && last < bars.length - 1) {
      e.preventDefault();
      move((v) => panView(bars, v, 1));
      setActive(lastIdx);
      return;
    }
    const next =
      e.key === 'ArrowLeft'
        ? cur - 1
        : e.key === 'ArrowRight'
          ? cur + 1
          : e.key === 'PageUp'
            ? cur - jump
            : e.key === 'PageDown'
              ? cur + jump
              : e.key === 'Home'
                ? 0
                : e.key === 'End'
                  ? lastIdx
                  : e.key === 'Escape'
                    ? null
                    : undefined;
    if (next === undefined) return;
    e.preventDefault();
    setActive(next === null ? null : Math.max(0, Math.min(lastIdx, next)));
  }

  const firstBar = vis[0];
  const lastBar = vis.at(-1);
  const sameDay =
    !!firstBar && !!lastBar && nyDate(new Date(firstBar.t)) === nyDate(new Date(lastBar.t));
  const axisScale = firstBar && lastBar ? axisScaleFor(firstBar.t, lastBar.t, sameDay) : range;
  const timeTicks = timeTickIndexes(vis.length, width < 560 ? 3 : 6);
  const up = bar ? bar.close >= bar.open : true;
  const fmtAxis = (v: number) => (comparing ? formatPercent(v, 1) : formatPrice(v));
  const span =
    firstBar && lastBar
      ? `${formatBarTime(firstBar.t, interval)} to ${formatBarTime(lastBar.t, interval)}`
      : '';

  // Labels on the right axis at each line's last value (N196), nudged apart so none overlap.
  const endLabels = useMemo(() => {
    if (!comparing) return [];
    const items = [
      { key: 'main', symbol, slot: 1, v: mainPct.pct.at(-1) ?? null },
      ...lines.map((l) => ({
        key: l.id,
        symbol: l.symbol,
        slot: l.slot,
        v: [...l.pct].reverse().find((p) => p !== null) ?? null,
      })),
    ]
      .filter((i): i is { key: string; symbol: string; slot: number; v: number } => i.v !== null)
      .map((i) => ({ ...i, y: geo.y(i.v) }))
      .sort((a, b) => a.y - b.y);
    let prevY = -Infinity;
    for (const item of items) {
      if (item.y - prevY < 16) item.y = prevY + 16;
      prevY = item.y;
    }
    return items;
  }, [comparing, symbol, mainPct, lines, geo]);

  return (
    <figure aria-labelledby={`${id}-title`} className="min-w-0">
      <figcaption id={`${id}-title`} className="sr-only">
        {symbol} price chart
      </figcaption>
      {/* The readout: the hovered bar, or the latest one in view. Values lead. */}
      <dl
        aria-live="polite"
        className="mb-2 flex flex-wrap gap-x-5 gap-y-1 text-sm tabular-nums"
        data-testid="chart-readout"
      >
        <div>
          <dt className="sr-only">Time</dt>
          <dd className="text-ink-muted">
            {bar ? formatBarTime(bar.t, interval) : '—'}
            {active === null && bar && atNewest && atLatest ? ' · latest' : ''}
          </dd>
        </div>
        {(
          [
            ['Open', bar?.open],
            ['High', bar?.high],
            ['Low', bar?.low],
            ['Close', bar?.close],
          ] as const
        ).map(([label, v]) => (
          <div key={label} className="flex gap-1">
            <dt className="text-ink-muted">{label}</dt>
            <dd className="text-content">{v === undefined ? '—' : formatPrice(v)}</dd>
          </div>
        ))}
        <div className="flex gap-1">
          <dt className="text-ink-muted">Volume</dt>
          <dd className="text-content">{bar ? formatVolume(bar.volume) : '—'}</dd>
        </div>
      </dl>
      {comparing && (
        <ul
          aria-label="Symbols on the chart"
          className="mb-2 flex flex-wrap gap-x-5 gap-y-1 text-sm tabular-nums"
          data-testid="compare-legend"
        >
          {[
            { key: 'main', symbol, slot: 1, b: bar ?? null, pct: mainPct.pct[shown] ?? null },
            ...lines.map((l) => ({
              key: l.id,
              symbol: l.symbol,
              slot: l.slot,
              b: l.aligned[shown] ?? null,
              pct: l.pct[shown] ?? null,
            })),
          ].map((s) => (
            <li key={s.key} className="flex items-center gap-1.5">
              <span aria-hidden className={`inline-block h-0.5 w-4 rounded ${SERIES_BG[s.slot]}`} />
              <span className="font-semibold">{s.symbol}</span>
              <span className="text-content">{s.b ? formatPrice(s.b.close) : '—'}</span>
              <span className="text-ink-muted">{s.pct === null ? '' : formatPercent(s.pct)}</span>
            </li>
          ))}
        </ul>
      )}
      <div
        ref={box}
        className={`relative transition-opacity ${dimmed ? 'opacity-50' : ''}`}
        aria-busy={dimmed}
      >
        <svg
          ref={svg}
          role="img"
          aria-label={summary}
          aria-describedby={`${id}-keys`}
          tabIndex={0}
          width={width}
          height={HEIGHT}
          viewBox={`0 0 ${width} ${HEIGHT}`}
          className="block max-w-full cursor-grab touch-pan-y rounded-sm select-none active:cursor-grabbing"
          onPointerDown={(e) => {
            drag.current = { x: e.clientX, view, panning: false };
            e.currentTarget.setPointerCapture?.(e.pointerId);
            setActive(indexAt(e.clientX, e.currentTarget));
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (d) {
              const dx = e.clientX - d.x;
              if (!d.panning && Math.abs(dx) < DRAG_PX) return;
              d.panning = true;
              const bars = barsRef.current;
              const shift = -(dx * pxPerScreenPx(e.currentTarget)) / Math.max(1, geo.step);
              setView(panView(bars, d.view, shift));
              setMoved(true);
              setActive(indexAt(e.clientX, e.currentTarget));
              return;
            }
            setActive(indexAt(e.clientX, e.currentTarget));
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
          onPointerLeave={(e) => {
            if (e.pointerType === 'mouse' && !drag.current) setActive(null);
          }}
          onKeyDown={onKey}
          onBlur={() => setActive(null)}
          data-testid="price-chart"
        >
          {/* Price grid and axis, recessive. */}
          {geo.ticks.map((v) => (
            <g key={v}>
              <line
                x1={LEFT}
                x2={LEFT + plotW}
                y1={geo.y(v)}
                y2={geo.y(v)}
                className={comparing && v === 0 ? 'stroke-ink-muted' : 'stroke-line'}
                strokeWidth={1}
              />
              {!comparing && (
                <text
                  x={LEFT + plotW + 8}
                  y={geo.y(v)}
                  dominantBaseline="middle"
                  className="fill-ink-muted text-[11px] tabular-nums"
                >
                  {fmtAxis(v)}
                </text>
              )}
              {comparing && (
                <text
                  x={LEFT + plotW + 8}
                  y={geo.y(v)}
                  dominantBaseline="middle"
                  className="fill-ink-muted text-[11px] tabular-nums"
                  opacity={endLabels.some((l) => Math.abs(l.y - geo.y(v)) < 12) ? 0 : 1}
                >
                  {fmtAxis(v)}
                </text>
              )}
            </g>
          ))}
          <line
            x1={LEFT}
            x2={LEFT + plotW}
            y1={geo.volTop + VOLUME_H}
            y2={geo.volTop + VOLUME_H}
            className="stroke-line"
          />
          <text
            x={LEFT + plotW + 8}
            y={geo.volTop + 8}
            dominantBaseline="middle"
            className="fill-ink-muted text-[11px] tabular-nums"
          >
            {formatVolume(geo.maxVol)}
          </text>
          <text
            x={LEFT + plotW + 8}
            y={geo.volTop + VOLUME_H - 4}
            className="fill-ink-muted text-[11px]"
          >
            Volume
          </text>

          {/* Compared symbols first, so the main one is drawn on top. */}
          {lines.map((l) => (
            <path
              key={l.id}
              d={brokenPath(l.pct.map((p, i) => (p === null ? null : [geo.x(i), geo.y(p)])))}
              fill="none"
              className={SERIES_STROKE[l.slot]}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              data-testid={`compare-line-${l.symbol}`}
            />
          ))}

          {/* Prices. */}
          {style === 'line' ? (
            <path
              d={linePath}
              fill="none"
              className={comparing ? SERIES_STROKE[1] : 'stroke-accent'}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ) : (
            vis.map((b, i) => {
              const rise = b.close >= b.open;
              const top = geo.y(val(Math.max(b.open, b.close)));
              const h = Math.max(1, Math.abs(geo.y(val(b.open)) - geo.y(val(b.close))));
              const cls = rise ? 'stroke-ok' : 'stroke-danger fill-danger';
              return (
                <g key={b.t} className={cls}>
                  <line
                    x1={geo.x(i)}
                    x2={geo.x(i)}
                    y1={geo.y(val(b.high))}
                    y2={geo.y(val(b.low))}
                  />
                  <rect
                    x={geo.x(i) - bodyW / 2}
                    y={top}
                    width={bodyW}
                    height={h}
                    // Rising bars are hollow, falling bars filled, so direction never rests on colour.
                    className={rise ? 'fill-surface' : undefined}
                    strokeWidth={1}
                  />
                </g>
              );
            })
          )}

          {/* The expected-move cone: ±1 standard deviation at each expiry's ATM IV. */}
          {conePts && (
            <g pointerEvents="none" data-testid="expected-move-cone">
              <path
                d={
                  conePts
                    .map(
                      (p, i) =>
                        `${i === 0 ? 'M' : 'L'}${geo.x(vis.length - 1 + p.ahead).toFixed(1)},${geo.y(p.upper).toFixed(1)}`,
                    )
                    .join('') +
                  [...conePts]
                    .reverse()
                    .map(
                      (p) =>
                        `L${geo.x(vis.length - 1 + p.ahead).toFixed(1)},${geo.y(p.lower).toFixed(1)}`,
                    )
                    .join('') +
                  'Z'
                }
                className="fill-series-1/15 stroke-series-1"
                strokeWidth={1}
                strokeDasharray="4 3"
              />
              <text
                x={geo.x(vis.length - 1 + extra) - 2}
                y={geo.y((conePts.at(-1) as ConePoint).upper) - 6}
                textAnchor="end"
                className="fill-ink-muted text-[11px]"
              >
                Expected move
              </text>
              <text
                x={LEFT + plotW}
                y={HEIGHT - 6}
                textAnchor="end"
                className="fill-ink-muted text-[11px]"
              >
                {(conePts.at(-1) as ConePoint).date}
              </text>
            </g>
          )}

          {/* Each line's latest value on the axis, with its colour beside it. */}
          {endLabels.map((l) => (
            <g key={l.key} pointerEvents="none">
              <rect
                x={LEFT + plotW + 2}
                y={l.y - 7}
                width={3}
                height={14}
                rx={1}
                className={SERIES_FILL[l.slot]}
              />
              <text
                x={LEFT + plotW + 8}
                y={l.y}
                dominantBaseline="middle"
                className="fill-ink text-[11px] font-medium tabular-nums"
              >
                {formatPercent(l.v, 1)}
              </text>
            </g>
          ))}

          {/* Volume. */}
          {vis.map((b, i) => (
            <rect
              key={b.t}
              x={geo.x(i) - volW / 2}
              y={geo.vy(b.volume)}
              width={volW}
              height={geo.volTop + VOLUME_H - geo.vy(b.volume)}
              className={i === active ? 'fill-ink-muted' : 'fill-ink-muted/35'}
            />
          ))}

          {/* Time axis. */}
          {timeTicks.map((i, n) => {
            const b = vis[i];
            if (!b) return null;
            const anchor =
              n === 0 ? 'start' : n === timeTicks.length - 1 && !extra ? 'end' : 'middle';
            return (
              <text
                key={i}
                x={anchor === 'start' ? LEFT : anchor === 'end' ? LEFT + plotW : geo.x(i)}
                y={HEIGHT - 6}
                textAnchor={anchor}
                className="fill-ink-muted text-[11px]"
              >
                {formatAxisTime(b.t, axisScale)}
              </text>
            );
          })}

          {/* Crosshair on the hovered or focused bar. */}
          {active !== null && bar && (
            <g pointerEvents="none">
              <line
                x1={geo.x(active)}
                x2={geo.x(active)}
                y1={TOP}
                y2={geo.volTop + VOLUME_H}
                className="stroke-ink-muted"
                strokeDasharray="3 3"
              />
              <line
                x1={LEFT}
                x2={LEFT + plotW}
                y1={geo.y(val(bar.close))}
                y2={geo.y(val(bar.close))}
                className="stroke-ink-muted"
                strokeDasharray="3 3"
              />
              {lines.map((l) => {
                const p = l.pct[active];
                return p === null || p === undefined ? null : (
                  <circle
                    key={l.id}
                    cx={geo.x(active)}
                    cy={geo.y(p)}
                    r={4}
                    className={`${SERIES_FILL[l.slot]} stroke-surface`}
                    strokeWidth={2}
                  />
                );
              })}
              <circle
                cx={geo.x(active)}
                cy={geo.y(val(bar.close))}
                r={4}
                className={`${comparing ? SERIES_FILL[1] : style === 'line' ? 'fill-accent' : up ? 'fill-ok' : 'fill-danger'} stroke-surface`}
                strokeWidth={2}
              />
              <rect
                x={LEFT + plotW + 2}
                y={geo.y(val(bar.close)) - 9}
                width={RIGHT - 4}
                height={18}
                rx={3}
                className="fill-ink"
              />
              <text
                x={LEFT + plotW + 8}
                y={geo.y(val(bar.close))}
                dominantBaseline="middle"
                className="fill-surface text-[11px] font-medium tabular-nums"
              >
                {comparing ? formatPercent(val(bar.close)) : formatPrice(bar.close)}
              </text>
            </g>
          )}
        </svg>
        {extending && (
          <p
            className={`pointer-events-none absolute top-2 rounded bg-surface-2 px-2 py-0.5 text-xs text-ink-muted ${extending === 'earlier' ? 'left-2' : 'right-20'}`}
          >
            Loading {extending} prices…
          </p>
        )}
      </div>

      {/* Moving through time: buttons for everything the pointer and keys can do. */}
      <div
        role="toolbar"
        aria-label="Move the chart"
        className="mt-2 flex flex-wrap items-center gap-2 text-sm"
      >
        <ToolButton
          label="Scroll back in time"
          disabled={first === 0 && atStart}
          onClick={() => panBy(-Math.max(1, Math.round(vis.length / 2)))}
        >
          ‹ Earlier
        </ToolButton>
        <ToolButton
          label="Scroll forward in time"
          disabled={atNewest && atLatest}
          onClick={() => panBy(Math.max(1, Math.round(vis.length / 2)))}
        >
          Later ›
        </ToolButton>
        <ToolButton
          label="Zoom out: show more bars"
          disabled={vis.length >= bars.length && atStart}
          onClick={() => move((v) => zoomView(bars, v, 1.5))}
        >
          −
        </ToolButton>
        <ToolButton
          label="Zoom in: show fewer bars"
          disabled={vis.length <= 10}
          onClick={() => move((v) => zoomView(bars, v, 1 / 1.5))}
        >
          +
        </ToolButton>
        {moved && (
          <ToolButton
            label="Back to the opening view"
            onClick={() => {
              setView(opening());
              setMoved(false);
            }}
          >
            Reset view
          </ToolButton>
        )}
        <span className="text-xs text-ink-muted tabular-nums" data-testid="chart-span">
          {span}
          {first === 0 && atStart && moved ? ' · start of the feed’s history' : ''}
        </span>
      </div>
      <p id={`${id}-keys`} className="mt-1 text-xs text-ink-muted">
        Point at the chart, or focus it and use the arrow keys, to read any bar. Drag it, swipe
        sideways or use Shift with the wheel to move through time; Ctrl or ⌘ with the wheel, a
        pinch, or the + and − keys zoom.
        {comparing &&
          ' With symbols to compare, each line is its percent change from the first bar in view.'}
        {conePts &&
          ` The shaded cone is the options market’s expected move from the last close (one standard deviation, at each expiry’s implied volatility) out to ${(conePts.at(-1) as ConePoint).date}: ${formatPrice((conePts.at(-1) as ConePoint).lower)} to ${formatPrice((conePts.at(-1) as ConePoint).upper)}.`}
        {style === 'candles' &&
          ' Hollow candles closed higher than they opened; filled ones lower.'}
      </p>
      <details className="mt-2">
        <summary className="cursor-pointer text-sm">Show prices as a table</summary>
        <div className="mt-2 max-h-96 overflow-y-auto">
          <Table label={`${symbol} prices`}>
            <thead>
              <tr>
                <Th>Time</Th>
                <Th numeric>Open $</Th>
                <Th numeric>High $</Th>
                <Th numeric>Low $</Th>
                <Th numeric>Close $</Th>
                <Th numeric>Volume</Th>
                {lines.map((l) => (
                  <Th key={l.id} numeric>
                    {l.symbol} close $
                  </Th>
                ))}
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {vis
                .map((b, i) => ({ b, i }))
                .reverse()
                .map(({ b, i }) => (
                  <tr key={b.t}>
                    <Td className="text-content">{formatBarTime(b.t, interval)}</Td>
                    <Td numeric>{bare(formatPrice(b.open))}</Td>
                    <Td numeric>{bare(formatPrice(b.high))}</Td>
                    <Td numeric>{bare(formatPrice(b.low))}</Td>
                    <Td numeric>{bare(formatPrice(b.close))}</Td>
                    <Td numeric>{formatVolume(b.volume)}</Td>
                    {lines.map((l) => {
                      const o = l.aligned[i];
                      return (
                        <Td key={l.id} numeric>
                          {o ? bare(formatPrice(o.close)) : '—'}
                        </Td>
                      );
                    })}
                  </tr>
                ))}
            </tbody>
          </Table>
        </div>
      </details>
    </figure>
  );
}

function ToolButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="h-7 min-w-7 rounded-md border border-line bg-surface-2 px-2 text-sm disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}
