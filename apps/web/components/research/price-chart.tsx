'use client';

import {
  tradingDaysBetween,
  type ChartInterval,
  type ChartRange,
  type ConePoint,
} from '@tm/domain';
import { Table, Td, Th } from '@tm/ui';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
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

export type ChartStyle = 'line' | 'candles';

const PRICE_H = 300;
const VOLUME_H = 72;
const GAP = 12;
const AXIS_H = 22;
const RIGHT = 72;
const LEFT = 4;
const TOP = 8;
const HEIGHT = TOP + PRICE_H + GAP + VOLUME_H + AXIS_H;

/**
 * An instrument's prices over time (ADR 0029): a price pane (closing line or
 * candles) above a volume pane on the same time axis, with a crosshair that
 * follows the pointer or the arrow keys, and every value also in a table.
 * Bars are spaced evenly, so nights, weekends and holidays leave no gaps.
 */
export function PriceChart({
  symbol,
  bars,
  interval,
  range,
  style,
  dimmed = false,
  cone = null,
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
}) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [active, setActive] = useState<number | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(280, Math.round(entry.contentRect.width)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // A new series starts without a pinned crosshair.
  useEffect(() => setActive(null), [bars]);

  const plotW = width - LEFT - RIGHT;
  // The cone starts at the last bar's close and runs one slot per trading day after the
  // chain's day, as percentage moves, so a chain a few minutes newer than the bars still fits.
  const conePts = useMemo(() => {
    const last = bars.at(-1);
    const start = cone?.[0];
    if (!cone || !start || cone.length < 2 || interval !== '1d' || !last) return null;
    return cone.map((p) => ({
      ...p,
      ahead: tradingDaysBetween(start.date, p.date),
      upper: last.close * (p.upper / start.upper),
      lower: last.close * (p.lower / start.lower),
    }));
  }, [cone, bars, interval]);
  const extra = conePts ? Math.max(0, ...conePts.map((p) => p.ahead)) : 0;
  const geo = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    let maxVol = 0;
    for (const b of bars) {
      const l = style === 'candles' ? b.low : b.close;
      const h = style === 'candles' ? b.high : b.close;
      if (l < lo) lo = l;
      if (h > hi) hi = h;
      if (b.volume > maxVol) maxVol = b.volume;
    }
    for (const p of conePts ?? []) {
      if (p.lower < lo) lo = p.lower;
      if (p.upper > hi) hi = p.upper;
    }
    const ticks = niceTicks(lo, hi, 5);
    const min = ticks[0] ?? lo;
    const max = ticks.at(-1) ?? hi;
    const step = plotW / Math.max(1, bars.length + extra);
    const x = (i: number) => LEFT + step * (i + 0.5);
    const y = (v: number) => TOP + PRICE_H - ((v - min) / (max - min || 1)) * PRICE_H;
    const volTop = TOP + PRICE_H + GAP;
    const vy = (v: number) => volTop + VOLUME_H - (maxVol ? (v / maxVol) * VOLUME_H : 0);
    return { ticks, step, x, y, vy, volTop, maxVol };
  }, [bars, plotW, style, conePts, extra]);

  const linePath = useMemo(
    () =>
      bars
        .map((b, i) => `${i === 0 ? 'M' : 'L'}${geo.x(i).toFixed(1)},${geo.y(b.close).toFixed(1)}`)
        .join(''),
    [bars, geo],
  );

  const summary = describeChart(symbol, bars, range, interval);
  const shown = active ?? bars.length - 1;
  const bar = bars[shown];
  const bodyW = Math.max(1, Math.min(12, geo.step * 0.7));
  const volW = Math.max(1, Math.min(12, geo.step - 2));

  function indexAt(clientX: number, el: Element) {
    const rect = el.getBoundingClientRect();
    const px = ((clientX - rect.left) / rect.width) * width;
    const i = Math.floor((px - LEFT) / geo.step);
    // The cone's slots have no bar: the readout stays on the last one.
    return Math.max(0, Math.min(bars.length - 1, i));
  }

  function onKey(e: React.KeyboardEvent) {
    const last = bars.length - 1;
    const cur = active ?? last;
    const jump = Math.max(1, Math.round(bars.length / 10));
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
                  ? last
                  : e.key === 'Escape'
                    ? null
                    : undefined;
    if (next === undefined) return;
    e.preventDefault();
    setActive(next === null ? null : Math.max(0, Math.min(last, next)));
  }

  const timeTicks = timeTickIndexes(bars.length, width < 560 ? 3 : 6);
  const up = bar ? bar.close >= bar.open : true;

  return (
    <figure aria-labelledby={`${id}-title`} className="min-w-0">
      <figcaption id={`${id}-title`} className="sr-only">
        {symbol} price chart
      </figcaption>
      {/* The readout: the hovered bar, or the latest one. Values lead. */}
      <dl
        aria-live="polite"
        className="mb-2 flex flex-wrap gap-x-5 gap-y-1 text-sm tabular-nums"
        data-testid="chart-readout"
      >
        <div>
          <dt className="sr-only">Time</dt>
          <dd className="text-ink-muted">
            {bar ? formatBarTime(bar.t, interval) : '—'}
            {active === null && bar ? ' · latest' : ''}
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
            <dd className="font-medium">{v === undefined ? '—' : formatPrice(v)}</dd>
          </div>
        ))}
        <div className="flex gap-1">
          <dt className="text-ink-muted">Volume</dt>
          <dd className="font-medium">{bar ? formatVolume(bar.volume) : '—'}</dd>
        </div>
      </dl>
      <div
        ref={box}
        className={`relative transition-opacity ${dimmed ? 'opacity-50' : ''}`}
        aria-busy={dimmed}
      >
        <svg
          role="img"
          aria-label={summary}
          aria-describedby={`${id}-keys`}
          tabIndex={0}
          width={width}
          height={HEIGHT}
          viewBox={`0 0 ${width} ${HEIGHT}`}
          className="block max-w-full touch-none rounded-sm select-none"
          onPointerMove={(e) => setActive(indexAt(e.clientX, e.currentTarget))}
          onPointerDown={(e) => setActive(indexAt(e.clientX, e.currentTarget))}
          onPointerLeave={(e) => {
            if (e.pointerType === 'mouse') setActive(null);
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
                className="stroke-line"
                strokeWidth={1}
              />
              <text
                x={LEFT + plotW + 8}
                y={geo.y(v)}
                dominantBaseline="middle"
                className="fill-ink-muted text-[11px] tabular-nums"
              >
                {formatPrice(v)}
              </text>
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

          {/* Prices. */}
          {style === 'line' ? (
            <path
              d={linePath}
              fill="none"
              className="stroke-accent"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ) : (
            bars.map((b, i) => {
              const rise = b.close >= b.open;
              const top = geo.y(Math.max(b.open, b.close));
              const h = Math.max(1, Math.abs(geo.y(b.open) - geo.y(b.close)));
              const cls = rise ? 'stroke-ok' : 'stroke-danger fill-danger';
              return (
                <g key={b.t} className={cls}>
                  <line x1={geo.x(i)} x2={geo.x(i)} y1={geo.y(b.high)} y2={geo.y(b.low)} />
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
                        `${i === 0 ? 'M' : 'L'}${geo.x(bars.length - 1 + p.ahead).toFixed(1)},${geo.y(p.upper).toFixed(1)}`,
                    )
                    .join('') +
                  [...conePts]
                    .reverse()
                    .map(
                      (p) =>
                        `L${geo.x(bars.length - 1 + p.ahead).toFixed(1)},${geo.y(p.lower).toFixed(1)}`,
                    )
                    .join('') +
                  'Z'
                }
                className="fill-series-1/15 stroke-series-1"
                strokeWidth={1}
                strokeDasharray="4 3"
              />
              <text
                x={geo.x(bars.length - 1 + extra) - 2}
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

          {/* Volume. */}
          {bars.map((b, i) => (
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
            const b = bars[i];
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
                {formatAxisTime(b.t, range)}
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
                y1={geo.y(bar.close)}
                y2={geo.y(bar.close)}
                className="stroke-ink-muted"
                strokeDasharray="3 3"
              />
              <circle
                cx={geo.x(active)}
                cy={geo.y(bar.close)}
                r={4}
                className={`${style === 'line' ? 'fill-accent' : up ? 'fill-ok' : 'fill-danger'} stroke-surface`}
                strokeWidth={2}
              />
              <rect
                x={LEFT + plotW + 2}
                y={geo.y(bar.close) - 9}
                width={RIGHT - 4}
                height={18}
                rx={3}
                className="fill-ink"
              />
              <text
                x={LEFT + plotW + 8}
                y={geo.y(bar.close)}
                dominantBaseline="middle"
                className="fill-surface text-[11px] font-medium tabular-nums"
              >
                {formatPrice(bar.close)}
              </text>
            </g>
          )}
        </svg>
      </div>
      <p id={`${id}-keys`} className="mt-1 text-xs text-ink-muted">
        Point at the chart, or focus it and use the arrow keys, to read any bar.
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
                <Th className="text-right">Open</Th>
                <Th className="text-right">High</Th>
                <Th className="text-right">Low</Th>
                <Th className="text-right">Close</Th>
                <Th className="text-right">Volume</Th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {[...bars].reverse().map((b) => (
                <tr key={b.t}>
                  <Td>{formatBarTime(b.t, interval)}</Td>
                  <Td className="text-right">{formatPrice(b.open)}</Td>
                  <Td className="text-right">{formatPrice(b.high)}</Td>
                  <Td className="text-right">{formatPrice(b.low)}</Td>
                  <Td className="text-right">{formatPrice(b.close)}</Td>
                  <Td className="text-right">{formatVolume(b.volume)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      </details>
    </figure>
  );
}
