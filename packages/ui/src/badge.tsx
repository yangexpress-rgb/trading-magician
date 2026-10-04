import type { ReactNode } from 'react';
import { cx } from './cx';
import {
  AlertIcon,
  CheckIcon,
  InfoIcon,
  LiveIcon,
  MinusCircleIcon,
  PaperIcon,
  XCircleIcon,
} from './icons';

export type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'paper';

const tones: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-ink-muted border-line',
  ok: 'bg-ok-soft text-ok border-ok/40',
  warn: 'bg-warn-soft text-warn border-warn/40',
  danger: 'bg-danger-soft text-danger border-danger/40',
  info: 'bg-info-soft text-info border-info/40',
  paper: 'bg-paper-soft text-paper border-paper/40',
};

const toneIcons: Record<Tone, ReactNode> = {
  neutral: <MinusCircleIcon />,
  ok: <CheckIcon />,
  warn: <AlertIcon />,
  danger: <XCircleIcon />,
  info: <InfoIcon />,
  paper: <PaperIcon />,
};

export interface BadgeProps {
  tone?: Tone;
  icon?: ReactNode | false;
  children: ReactNode;
  className?: string;
}

/** A status label: always text plus icon, never colour alone. */
export function Badge({ tone = 'neutral', icon, children, className }: BadgeProps) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold whitespace-nowrap',
        tones[tone],
        className,
      )}
    >
      {icon === false ? null : (icon ?? toneIcons[tone])}
      {children}
    </span>
  );
}

/** Account mode, shown wherever it matters (§5.1). */
export function ModeBadge({ mode }: { mode: 'paper' | 'live' }) {
  return mode === 'paper' ? (
    <Badge tone="paper" icon={<PaperIcon />}>
      <span>Paper</span>
      <span className="sr-only"> trading mode</span>
    </Badge>
  ) : (
    <Badge tone="danger" icon={<LiveIcon />}>
      <span>Live</span>
      <span className="sr-only"> trading mode</span>
    </Badge>
  );
}
