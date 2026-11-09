import type { ReactNode } from 'react';
import { cx } from './cx';

export function Table({ children, label }: { children: ReactNode; label: string }) {
  return (
    // Focusable so keyboard users can scroll a table wider than the screen (WCAG 2.1.1).
    <div
      tabIndex={0}
      role="group"
      aria-label={label}
      className="overflow-x-auto rounded-lg border border-line bg-surface"
    >
      <table aria-label={label} className="w-full border-collapse text-sm">
        {children}
      </table>
    </div>
  );
}

/**
 * Column header. `numeric` right-aligns it over a numeric column so the header
 * sits on the same edge as the figures below it (content and interface, N128).
 */
export function Th({
  children,
  className,
  numeric = false,
  sort,
}: {
  children?: ReactNode;
  className?: string | undefined;
  numeric?: boolean;
  /** The column's sort state, for a sortable column. */
  sort?: 'ascending' | 'descending' | 'none' | undefined;
}) {
  return (
    <th
      scope="col"
      aria-sort={sort}
      className={cx(
        'border-b border-line bg-surface-2 px-3 py-2 text-xs font-semibold tracking-wide text-ink-muted uppercase',
        numeric ? 'text-right' : 'text-left',
        className,
      )}
    >
      {children}
    </th>
  );
}

/**
 * Table cell. A cell holds content (brief v2.2 D3, N128): it is set in
 * `text-content`, the content colour at medium weight with tabular figures.
 * `numeric` marks a cell that shows a number (amount, price, quantity,
 * percentage, count): right-aligned, so a column of numbers lines up on one
 * edge. Text columns stay left-aligned; no column is centred. Badges, buttons
 * and muted meta lines inside a cell keep their own colours.
 */
export function Td({
  children,
  className,
  numeric = false,
}: {
  children?: ReactNode;
  className?: string | undefined;
  numeric?: boolean;
}) {
  return (
    <td
      className={cx(
        'border-b border-line px-3 py-2 align-middle text-content',
        numeric && 'text-right',
        className,
      )}
    >
      {children}
    </td>
  );
}

/** A numeric table cell: `<Td numeric>`. */
export function TdNumeric({
  children,
  className,
}: {
  children?: ReactNode;
  className?: string | undefined;
}) {
  return (
    <Td numeric className={className}>
      {children}
    </Td>
  );
}
