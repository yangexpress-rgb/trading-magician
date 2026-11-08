import type { ReactNode } from 'react';
import { cx } from './cx';

/**
 * One value with its label (data text role, N129). The label is muted meta
 * text; the value is set in `text-data` (tabular figures), or in
 * `text-data-strong` when it is the single primary figure on a card or page.
 * A missing value shows "—", never 0 or a blank.
 *
 * Renders a <div> holding a <dt>/<dd> pair, so it belongs inside a <dl>.
 */
export function DataValue({
  label,
  value,
  primary = false,
  className,
  valueClassName,
}: {
  label: ReactNode;
  value: ReactNode;
  primary?: boolean;
  className?: string | undefined;
  valueClassName?: string | undefined;
}) {
  const missing = value === null || value === undefined || value === '';
  return (
    <div className={className}>
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd
        className={cx(
          primary ? 'text-data-strong' : 'text-data',
          missing && 'text-ink-muted',
          valueClassName,
        )}
      >
        {missing ? '—' : value}
      </dd>
    </div>
  );
}

/**
 * A stat card figure: label above, one primary figure in `text-data-strong` at
 * the size stat cards already use (text-lg), and at most one comparison line.
 * Renders a <div> of <dt>/<dd>, so it belongs inside a <dl>.
 */
export function Stat({
  label,
  value,
  comparison,
  className,
  valueClassName,
}: {
  label: ReactNode;
  value: ReactNode;
  comparison?: ReactNode;
  className?: string | undefined;
  valueClassName?: string | undefined;
}) {
  const missing = value === null || value === undefined || value === '';
  return (
    <div className={className}>
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className={cx('text-lg text-data-strong', missing && 'text-ink-muted', valueClassName)}>
        {missing ? '—' : value}
      </dd>
      {comparison && <dd className="text-xs text-ink-muted">{comparison}</dd>}
    </div>
  );
}
