'use client';

import { Table, Td, Th } from '@tm/ui';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { niceTicks } from '@/lib/research-text';

/**
 * Small charts for Research › Options (ADR 0048): a line (smile, term
 * structure, IV history) and mirrored bars by strike (open interest, gamma).
 * One y-axis each, recessive grid, a hover or arrow-key readout, and every
 * value also in a table.
 */

const H = 180;
const TOP = 8;
const BOTTOM = 22;
const LEFT = 4;
const RIGHT = 60;

function useWidth() {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(480);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      if (e) setWidth(Math.max(240, Math.round(e.contentRect.width)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { box, width };
}

function keyStep(e: React.KeyboardEvent, cur: number | null, n: number) {
  const last = n - 1;
  const at = cur ?? last;
  const next =
    e.key === 'ArrowLeft'
      ? at - 1
      : e.key === 'ArrowRight'
        ? at + 1
        : e.key === 'Home'
          ? 0
          : e.key === 'End'
            ? last
            : e.key === 'Escape'
              ? null
              : undefined;
  if (next === undefined) return undefined;
  e.preventDefault();
  return next === null ? null : Math.max(0, Math.min(last, next));
}

export interface LinePoint {
  x: number;
  y: number | null;
  /** A lighter point (rebuilt history, brief §5.2). */
  light?: boolean;
  /** Shown in the readout and the table. */
  label: string;
}

/** A line over evenly spaced points; `light` points draw in a lighter, dashed line. */
export function MiniLine({
  title,
  points,
  formatY,
  xLabel,
  yLabel,
  marker,
  legend,
}: {
  title: string;
  points: readonly LinePoint[];
  formatY: (v: number) => string;
  xLabel: string;
  yLabel: string;
  /** A vertical marker, e.g. the price on a smile (x in the points' scale). */
  marker?: { x: number; label: string } | undefined;
  legend?: ReactNode;
}) {
  const id = useId();
  const { box, width } = useWidth();
  const [active, setActive] = useState<number | null>(null);
  const plotW = width - LEFT - RIGHT;
  const ys = points.map((p) => p.y).filter((v): v is number => v != null);
  if (points.length < 2 || ys.length < 2)
    return (
      <figure>
        <figcaption className="text-sm font-medium">{title}</figcaption>
        <p className="py-6 text-sm text-ink-muted">Not enough values to draw.</p>
      </figure>
    );
  const xs = points.map((p) => p.x);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const ticks = niceTicks(Math.min(...ys), Math.max(...ys), 4);
  const yMin = ticks[0] ?? Math.min(...ys);
  const yMax = ticks.at(-1) ?? Math.max(...ys);
  const x = (v: number) => LEFT + ((v - xMin) / (xMax - xMin || 1)) * plotW;
  const y = (v: number) => TOP + (H - TOP - BOTTOM) * (1 - (v - yMin) / (yMax - yMin || 1));
  const segs: { d: string; light: boolean }[] = [];
  let cur: { d: string; light: boolean } | undefined;
  let prev: LinePoint | undefined;
  for (const p of points) {
    if (p.y == null) {
      cur = undefined;
      prev = undefined;
      continue;
    }
    const light = !!p.light;
    if (!cur || cur.light !== light) {
      cur = {
        d: prev && prev.y != null ? `M${x(prev.x)},${y(prev.y)}` : '',
        light,
      };
      segs.push(cur);
    }
    cur.d += `${cur.d ? 'L' : 'M'}${x(p.x).toFixed(1)},${y(p.y).toFixed(1)}`;
    prev = p;
  }
  const shown = active === null ? undefined : points[active];
  const indexAt = (clientX: number, el: Element) => {
    const r = el.getBoundingClientRect();
    const px = ((clientX - r.left) / r.width) * width;
    let best = 0;
    points.forEach((p, i) => {
      if (Math.abs(x(p.x) - px) < Math.abs(x((points[best] as LinePoint).x) - px)) best = i;
    });
    return best;
  };
  return (
    <figure aria-labelledby={`${id}-t`} className="min-w-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <figcaption id={`${id}-t`} className="text-sm font-medium">
          {title}
        </figcaption>
        <p className="text-xs text-ink-muted tabular-nums" aria-live="polite">
          {shown ? `${shown.label}: ${shown.y == null ? '—' : formatY(shown.y)}` : yLabel}
        </p>
      </div>
      {legend}
      <div ref={box}>
        <svg
          role="img"
          aria-label={`${title}, ${points.length} points`}
          tabIndex={0}
          width={width}
          height={H}
          viewBox={`0 0 ${width} ${H}`}
          className="block max-w-full touch-none select-none"
          onPointerMove={(e) => setActive(indexAt(e.clientX, e.currentTarget))}
          onPointerDown={(e) => setActive(indexAt(e.clientX, e.currentTarget))}
          onPointerLeave={(e) => e.pointerType === 'mouse' && setActive(null)}
          onKeyDown={(e) => {
            const n = keyStep(e, active, points.length);
            if (n !== undefined) setActive(n);
          }}
          onBlur={() => setActive(null)}
        >
          {ticks.map((v) => (
            <g key={v}>
              <line x1={LEFT} x2={LEFT + plotW} y1={y(v)} y2={y(v)} className="stroke-line" />
              <text
                x={LEFT + plotW + 6}
                y={y(v)}
                dominantBaseline="middle"
                className="fill-ink-muted text-[11px] tabular-nums"
              >
                {formatY(v)}
              </text>
            </g>
          ))}
          {marker && marker.x >= xMin && marker.x <= xMax && (
            <g>
              <line
                x1={x(marker.x)}
                x2={x(marker.x)}
                y1={TOP}
                y2={H - BOTTOM}
                className="stroke-ink-muted"
                strokeDasharray="2 3"
              />
              <text x={x(marker.x) + 4} y={TOP + 10} className="fill-ink-muted text-[11px]">
                {marker.label}
              </text>
            </g>
          )}
          {segs.map((s, i) => (
            <path
              key={i}
              d={s.d}
              fill="none"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              className={s.light ? 'stroke-series-1/45' : 'stroke-series-1'}
              strokeDasharray={s.light ? '4 3' : undefined}
            />
          ))}
          <text x={LEFT} y={H - 6} className="fill-ink-muted text-[11px]">
            {points[0]?.label}
          </text>
          <text x={LEFT + plotW} y={H - 6} textAnchor="end" className="fill-ink-muted text-[11px]">
            {points.at(-1)?.label}
          </text>
          {shown && shown.y != null && (
            <g pointerEvents="none">
              <line
                x1={x(shown.x)}
                x2={x(shown.x)}
                y1={TOP}
                y2={H - BOTTOM}
                className="stroke-ink-muted"
                strokeDasharray="3 3"
              />
              <circle
                cx={x(shown.x)}
                cy={y(shown.y)}
                r={4}
                className="fill-series-1 stroke-surface"
                strokeWidth={2}
              />
            </g>
          )}
        </svg>
      </div>
      <details className="mt-1">
        <summary className="cursor-pointer text-xs">Show as a table</summary>
        <div className="mt-2 max-h-64 overflow-y-auto">
          <Table label={title}>
            <thead>
              <tr>
                <Th>{xLabel}</Th>
                <Th numeric>{yLabel}</Th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {points.map((p) => (
                <tr key={`${p.x}`}>
                  <Td>
                    {p.label}
                    {p.light ? ' (rebuilt)' : ''}
                  </Td>
                  <Td numeric>{p.y == null ? '—' : formatY(p.y)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      </details>
    </figure>
  );
}

export interface StrikeBar {
  strike: number;
  call: number;
  put: number;
}

/**
 * Calls above the axis and puts below it, one slot per strike, with the
 * price marked. `net` adds a calls − puts readout (gamma).
 */
export function StrikeBars({
  title,
  bars,
  price,
  format,
  net = false,
}: {
  title: string;
  bars: readonly StrikeBar[];
  price: number;
  format: (v: number) => string;
  net?: boolean;
}) {
  const id = useId();
  const { box, width } = useWidth();
  const [active, setActive] = useState<number | null>(null);
  if (bars.length === 0)
    return (
      <figure>
        <figcaption className="text-sm font-medium">{title}</figcaption>
        <p className="py-6 text-sm text-ink-muted">No open interest to draw.</p>
      </figure>
    );
  const plotW = width - LEFT - RIGHT;
  const max = Math.max(1e-9, ...bars.map((b) => Math.max(b.call, b.put)));
  const step = plotW / bars.length;
  const mid = TOP + (H - TOP - BOTTOM) / 2;
  const half = (H - TOP - BOTTOM) / 2 - 2;
  const bw = Math.max(1, Math.min(10, step - 2));
  const xi = (i: number) => LEFT + step * (i + 0.5);
  const priceIndex = bars.findIndex((b) => b.strike >= price);
  const priceX =
    priceIndex <= 0
      ? xi(0)
      : xi(priceIndex - 1) +
        (step * (price - (bars[priceIndex - 1] as StrikeBar).strike)) /
          ((bars[priceIndex] as StrikeBar).strike - (bars[priceIndex - 1] as StrikeBar).strike ||
            1);
  const shown = active === null ? undefined : bars[active];
  return (
    <figure aria-labelledby={`${id}-t`} className="min-w-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <figcaption id={`${id}-t`} className="text-sm font-medium">
          {title}
        </figcaption>
        <p className="text-xs text-ink-muted tabular-nums" aria-live="polite">
          {shown
            ? `Strike ${shown.strike}: calls ${format(shown.call)}, puts ${format(shown.put)}${net ? `, net ${format(shown.call - shown.put)}` : ''}`
            : ''}
        </p>
      </div>
      <SeriesLegend />
      <div ref={box}>
        <svg
          role="img"
          aria-label={`${title}, ${bars.length} strikes; calls above the line, puts below`}
          tabIndex={0}
          width={width}
          height={H}
          viewBox={`0 0 ${width} ${H}`}
          className="block max-w-full touch-none select-none"
          onPointerMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const px = ((e.clientX - r.left) / r.width) * width;
            setActive(Math.max(0, Math.min(bars.length - 1, Math.floor((px - LEFT) / step))));
          }}
          onPointerLeave={(e) => e.pointerType === 'mouse' && setActive(null)}
          onKeyDown={(e) => {
            const n = keyStep(e, active, bars.length);
            if (n !== undefined) setActive(n);
          }}
          onBlur={() => setActive(null)}
        >
          <line x1={LEFT} x2={LEFT + plotW} y1={mid} y2={mid} className="stroke-line" />
          <text
            x={LEFT + plotW + 6}
            y={TOP + 8}
            className="fill-ink-muted text-[11px] tabular-nums"
          >
            {format(max)}
          </text>
          <text
            x={LEFT + plotW + 6}
            y={H - BOTTOM - 2}
            className="fill-ink-muted text-[11px] tabular-nums"
          >
            {format(max)}
          </text>
          {bars.map((b, i) => {
            const hc = (b.call / max) * half;
            const hp = (b.put / max) * half;
            return (
              <g key={b.strike} opacity={active === null || active === i ? 1 : 0.55}>
                <rect
                  x={xi(i) - bw / 2}
                  y={mid - 1 - hc}
                  width={bw}
                  height={hc}
                  rx={Math.min(2, bw / 2)}
                  className="fill-series-1"
                />
                <rect
                  x={xi(i) - bw / 2}
                  y={mid + 1}
                  width={bw}
                  height={hp}
                  rx={Math.min(2, bw / 2)}
                  className="fill-series-2"
                />
              </g>
            );
          })}
          <line
            x1={priceX}
            x2={priceX}
            y1={TOP}
            y2={H - BOTTOM}
            className="stroke-ink"
            strokeDasharray="2 3"
          />
          <text x={priceX + 4} y={TOP + 10} className="fill-ink text-[11px]">
            Price
          </text>
          <text x={LEFT} y={H - 6} className="fill-ink-muted text-[11px] tabular-nums">
            {bars[0]?.strike}
          </text>
          <text
            x={LEFT + plotW}
            y={H - 6}
            textAnchor="end"
            className="fill-ink-muted text-[11px] tabular-nums"
          >
            {bars.at(-1)?.strike}
          </text>
        </svg>
      </div>
      <details className="mt-1">
        <summary className="cursor-pointer text-xs">Show as a table</summary>
        <div className="mt-2 max-h-64 overflow-y-auto">
          <Table label={title}>
            <thead>
              <tr>
                <Th>Strike</Th>
                <Th numeric>Calls</Th>
                <Th numeric>Puts</Th>
                {net && <Th numeric>Net</Th>}
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {bars.map((b) => (
                <tr key={b.strike}>
                  <Td>{b.strike}</Td>
                  <Td numeric>{format(b.call)}</Td>
                  <Td numeric>{format(b.put)}</Td>
                  {net && <Td numeric>{format(b.call - b.put)}</Td>}
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      </details>
    </figure>
  );
}

export function SeriesLegend() {
  return (
    <p className="flex gap-4 text-xs text-ink-muted">
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="inline-block size-2.5 rounded-sm bg-series-1" />
        Calls (above)
      </span>
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="inline-block size-2.5 rounded-sm bg-series-2" />
        Puts (below)
      </span>
    </p>
  );
}
