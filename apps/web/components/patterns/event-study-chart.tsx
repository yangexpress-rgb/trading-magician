import type { EventStudyPoint } from '@tm/domain';

const W = 640;
const H = 240;
const PAD = { left: 52, right: 12, top: 12, bottom: 32 };

const pct = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(1)}%`;

/**
 * The event study (pattern brief §8): the mean move from the occurrence
 * day's close, day by day, with a ±1 standard error band.
 */
export function EventStudyChart({ points, label }: { points: EventStudyPoint[]; label: string }) {
  const usable = points.filter((p) => p.n > 0);
  const head = usable[0];
  const end = usable[usable.length - 1];
  if (!head || !end || usable.length < 2)
    return <p className="text-sm text-ink-muted">Not enough occurrences to chart.</p>;
  const lo = Math.min(0, ...usable.map((p) => p.mean - p.se));
  const hi = Math.max(0, ...usable.map((p) => p.mean + p.se));
  const span = hi - lo || 0.01;
  const first = head.offset;
  const last = end.offset;
  const x = (o: number) => PAD.left + ((o - first) / (last - first)) * (W - PAD.left - PAD.right);
  const y = (v: number) => PAD.top + ((hi - v) / span) * (H - PAD.top - PAD.bottom);
  const line = usable
    .map((p, i) => `${i ? 'L' : 'M'}${x(p.offset).toFixed(1)},${y(p.mean).toFixed(1)}`)
    .join('');
  const band =
    usable
      .map((p, i) => `${i ? 'L' : 'M'}${x(p.offset).toFixed(1)},${y(p.mean + p.se).toFixed(1)}`)
      .join('') +
    [...usable]
      .reverse()
      .map((p) => `L${x(p.offset).toFixed(1)},${y(p.mean - p.se).toFixed(1)}`)
      .join('') +
    'Z';
  const ticks = [lo, 0, hi];
  const xTicks = [first, 0, Math.round(last / 2), last].filter((v, i, a) => a.indexOf(v) === i);
  return (
    <figure className="space-y-2">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={label}
        className="w-full max-w-3xl text-ink-muted"
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(t)}
              y2={y(t)}
              stroke="currentColor"
              strokeOpacity={t === 0 ? 0.6 : 0.2}
            />
            <text x={PAD.left - 6} y={y(t) + 4} textAnchor="end" fontSize="11" fill="currentColor">
              {pct(t)}
            </text>
          </g>
        ))}
        {xTicks.map((t) => (
          <text key={t} x={x(t)} y={H - 10} textAnchor="middle" fontSize="11" fill="currentColor">
            {t === 0 ? 'Day 0' : `${t > 0 ? '+' : ''}${t}d`}
          </text>
        ))}
        <line
          x1={x(0)}
          x2={x(0)}
          y1={PAD.top}
          y2={H - PAD.bottom}
          stroke="currentColor"
          strokeDasharray="3 3"
          strokeOpacity={0.6}
        />
        <path d={band} className="fill-accent" fillOpacity={0.18} />
        <path d={line} className="stroke-accent" fill="none" strokeWidth={2} />
      </svg>
      <figcaption className="text-sm text-ink-muted">
        Mean close-to-close move from the occurrence day, with ±1 standard error. By day{' '}
        {end.offset}: <span className="text-content">{pct(end.mean)}</span> (n = {end.n}).
      </figcaption>
    </figure>
  );
}
