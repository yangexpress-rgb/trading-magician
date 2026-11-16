import { cx } from '@tm/ui';
import type { ReactNode } from 'react';
import type { MetricTile } from '@/lib/backtest-text';
import { signTone } from '@/lib/sign-tone';

/**
 * A figure that can gain or lose (N289): green above zero, red below, ink at
 * zero or when missing, and never wrapped, so "−" stays with "$1,032.08".
 */
export function Signed({
  value,
  children,
  className,
}: {
  value: number | string | null | undefined;
  children: ReactNode;
  className?: string | undefined;
}) {
  return <span className={cx('whitespace-nowrap', signTone(value), className)}>{children}</span>;
}

/** A headline tile's value: coloured by its sign, or part by part (N289). */
export function TileValue({ tile }: { tile: MetricTile }) {
  if (tile.parts) {
    return (
      <>
        {tile.parts.map((p, i) => (
          <span key={i}>
            {i > 0 && ' / '}
            <Signed value={p.sign}>{p.text}</Signed>
          </span>
        ))}
      </>
    );
  }
  return <Signed value={tile.sign}>{tile.value}</Signed>;
}
