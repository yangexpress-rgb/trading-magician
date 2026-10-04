import type { ReactNode } from 'react';
import { cx } from './cx';

export function Table({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-surface">
      <table aria-label={label} className="w-full border-collapse text-sm">
        {children}
      </table>
    </div>
  );
}

export function Th({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <th
      scope="col"
      className={cx(
        'border-b border-line bg-surface-2 px-3 py-2 text-left text-xs font-semibold tracking-wide text-ink-muted uppercase',
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <td className={cx('border-b border-line px-3 py-2 align-middle', className)}>{children}</td>
  );
}
