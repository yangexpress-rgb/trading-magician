'use client';

import { useId } from 'react';
import { formatMoney, linePath } from '@/lib/backtest-text';

/**
 * A simple line chart with a text summary for screen readers, shared by back
 * test results and the Performance tab.
 */
export function LineChart({
  title,
  values,
  times,
  summary,
  format = formatMoney,
}: {
  title: string;
  values: number[];
  times: string[];
  summary: string;
  format?: (value: number) => string;
}) {
  const id = useId();
  const { path, min, max } = linePath(values, 600, 160);
  return (
    <figure aria-labelledby={id} className="rounded-md border border-line p-3">
      <figcaption id={id} className="mb-1 text-sm font-medium">
        {title}
      </figcaption>
      <div className="flex gap-2">
        <div className="flex flex-col justify-between text-right text-xs text-ink-muted tabular-nums">
          <span>{format(max)}</span>
          <span>{format(min)}</span>
        </div>
        <svg
          role="img"
          aria-label={summary}
          viewBox="0 0 600 160"
          preserveAspectRatio="none"
          className="h-40 w-full text-accent"
        >
          <path
            d={path}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </div>
      <div className="mt-1 flex justify-between pl-16 text-xs text-ink-muted">
        <span>{times[0] ?? ''}</span>
        <span>{times.at(-1) ?? ''}</span>
      </div>
    </figure>
  );
}
