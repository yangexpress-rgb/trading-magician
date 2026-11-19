import { isValidElement, type ReactNode } from 'react';
import { cx } from './cx';
import { SortButton, Table } from './sortable-table';

export { Table };

/** A header holding only screen-reader text (an actions column) has nothing to sort. */
function onlyHiddenText(children: ReactNode): boolean {
  return (
    isValidElement<{ className?: string }>(children) &&
    typeof children.props.className === 'string' &&
    children.props.className.split(/\s+/).includes('sr-only')
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
  sortable = true,
  filter,
}: {
  children?: ReactNode;
  className?: string | undefined;
  numeric?: boolean;
  /** A control beside the label that filters the rows by this column (N304). */
  filter?: ReactNode;
  /**
   * The column's sort state, for a list that sorts itself (by URL, on the
   * server). Without it the header sorts the rows in the page (N303).
   */
  sort?: 'ascending' | 'descending' | 'none' | undefined;
  /** false: this column's header does not sort. */
  sortable?: boolean;
}) {
  const sorts =
    sort === undefined &&
    sortable &&
    children !== undefined &&
    children !== null &&
    children !== '' &&
    !onlyHiddenText(children);
  return (
    <th
      scope="col"
      aria-sort={sort}
      className={cx(
        'border-b border-line bg-surface-2 px-3 py-2 text-xs font-semibold tracking-wide text-ink-muted uppercase',
        numeric ? 'text-right' : 'text-left',
        // Funnels line up along the bottom of the header row.
        filter && 'align-bottom',
        className,
      )}
    >
      {filter ? (
        // The filter sits under the label, on the column's edge, so a list
        // with many columns stays as narrow as its labels.
        <span className={cx('flex flex-col gap-0.5', numeric ? 'items-end' : 'items-start')}>
          {sorts ? <SortButton numeric={numeric}>{children}</SortButton> : children}
          {filter}
        </span>
      ) : sorts ? (
        <SortButton numeric={numeric}>{children}</SortButton>
      ) : (
        children
      )}
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
  sortValue,
}: {
  children?: ReactNode;
  className?: string | undefined;
  numeric?: boolean;
  /** What the column sorts this cell by, when its text would sort wrongly. */
  sortValue?: string | number | undefined;
}) {
  return (
    <td
      data-sort-value={sortValue}
      className={cx(
        'border-b border-line px-3 py-2 align-middle text-content',
        // A number never wraps, so a sign stays with its figure (N286).
        numeric && 'text-right whitespace-nowrap',
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
