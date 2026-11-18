'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { cx } from './cx';
import {
  columnValues,
  nextSort,
  parseSort,
  sortedOrder,
  type CellValue,
  type TableSort,
} from './table-sort';

type SortContext = {
  sort: TableSort | null;
  onSort: (col: number) => void;
};

const Ctx = createContext<SortContext | null>(null);

const STORAGE_PREFIX = 'tm.tableSort.';

/** The column a cell starts at, counting the spans of the cells before it. */
function columnOf(cell: HTMLTableCellElement): number {
  let col = 0;
  let prev = cell.previousElementSibling;
  while (prev) {
    if (prev instanceof HTMLTableCellElement) col += prev.colSpan;
    prev = prev.previousElementSibling;
  }
  return col;
}

/** The cell of `row` that covers column `col`, or null. */
function cellAt(row: HTMLTableRowElement, col: number): HTMLTableCellElement | null {
  let at = 0;
  for (const cell of Array.from(row.cells)) {
    if (col < at + cell.colSpan) return at === col ? cell : null;
    at += cell.colSpan;
  }
  return null;
}

/** What a cell is sorted by: its `data-sort-value`, a `<time>`'s date, else its text. */
function cellSortText(cell: HTMLTableCellElement | null): string | null {
  if (!cell) return null;
  const given = cell.dataset.sortValue;
  if (given !== undefined) return given;
  const time = cell.querySelector('time[datetime]')?.getAttribute('datetime');
  if (time) {
    const ms = Date.parse(time);
    if (!Number.isNaN(ms)) return String(ms);
  }
  return cell.textContent ?? '';
}

/**
 * Puts the body rows of `table` in the order `sort` asks for, or back in the
 * list's own order. Rows only move inside their own `<tbody>`, so React's
 * later updates (live prices, refreshes) still find every row where it can
 * insert and remove them; a watcher then sorts again.
 */
function applySort(
  table: HTMLTableElement,
  sort: TableSort | null,
  original: WeakMap<HTMLTableRowElement, number>,
) {
  for (const body of Array.from(table.tBodies)) {
    const rows = Array.from(body.rows);
    if (rows.length < 2) continue;
    rows.forEach((r, i) => {
      if (!original.has(r)) original.set(r, sort ? i : Number.MAX_SAFE_INTEGER);
    });
    let order: number[];
    if (sort) {
      // A row with one cell across the whole table (a note, "No orders yet")
      // keeps no value and so stays at the end.
      const values: CellValue[] = columnValues(rows.map((r) => cellSortText(cellAt(r, sort.col))));
      order = sortedOrder(values, sort.dir);
    } else {
      order = rows
        .map((r, i) => ({ o: original.get(r) ?? Number.MAX_SAFE_INTEGER, i }))
        .sort((a, b) => a.o - b.o || a.i - b.i)
        .map((x) => x.i);
    }
    if (order.every((o, i) => o === i)) continue;
    for (const i of order) {
      const row = rows[i];
      if (row) body.appendChild(row);
    }
  }
}

/**
 * A report table. Every column header sorts the rows by that column (N303):
 * the first click low to high, the next high to low, the third back to the
 * list's own order. The choice is remembered in this browser for each list.
 * `sortable={false}` keeps the rows in their given order, for tables that
 * read top to bottom (a statement, a plan comparison).
 */
export function Table({
  children,
  label,
  sortable = true,
}: {
  children: ReactNode;
  label: string;
  sortable?: boolean;
}) {
  const tableRef = useRef<HTMLTableElement>(null);
  const original = useRef(new WeakMap<HTMLTableRowElement, number>());
  const [sort, setSort] = useState<TableSort | null>(null);
  // Whether the rows have been moved, so a return to the list order has work to do.
  const sorted = useRef(false);
  const storageKey = STORAGE_PREFIX + label;

  // The remembered sort, read once the page is in the browser.
  useEffect(() => {
    if (!sortable) return;
    let saved: TableSort | null = null;
    try {
      saved = parseSort(window.localStorage.getItem(storageKey));
    } catch {
      saved = null;
    }
    setSort(saved);
  }, [sortable, storageKey]);

  const onSort = useCallback(
    (col: number) => {
      setSort((current) => {
        const next = nextSort(current, col);
        try {
          if (next) window.localStorage.setItem(storageKey, JSON.stringify(next));
          else window.localStorage.removeItem(storageKey);
        } catch {
          // Storage can be blocked; the sort still applies on this page.
        }
        return next;
      });
    },
    [storageKey],
  );

  // Sort now, and again whenever the rows change underneath.
  useEffect(() => {
    const table = tableRef.current;
    if (!table || !sortable) return;
    let frame = 0;
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(run);
    });
    const watch = () =>
      observer.observe(table, { childList: true, subtree: true, characterData: true });
    function run() {
      if (!table) return;
      if (!sort && !sorted.current) return;
      sorted.current = sort !== null;
      observer.disconnect();
      // A remembered column the table no longer has is dropped.
      const columns = table.tHead?.rows[table.tHead.rows.length - 1];
      const width = columns
        ? Array.from(columns.cells).reduce((n, c) => n + c.colSpan, 0)
        : Number.MAX_SAFE_INTEGER;
      applySort(table, sort && sort.col < width ? sort : null, original.current);
      if (!sort) original.current = new WeakMap();
      if (sort) watch();
    }
    run();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [sort, sortable]);

  // The sorted header carries aria-sort; Th leaves it to us unless the list sorts itself.
  useEffect(() => {
    const head = tableRef.current?.tHead;
    if (!head || !sortable) return;
    for (const th of Array.from(head.querySelectorAll<HTMLTableCellElement>('th[data-sortable]'))) {
      const dir = sort?.col === columnOf(th) ? sort.dir : null;
      th.setAttribute(
        'aria-sort',
        dir === null ? 'none' : dir === 'asc' ? 'ascending' : 'descending',
      );
    }
  }, [sort, sortable]);

  return (
    // Focusable so keyboard users can scroll a table wider than the screen (WCAG 2.1.1).
    <div
      tabIndex={0}
      role="group"
      aria-label={label}
      className="overflow-x-auto rounded-lg border border-line bg-surface"
    >
      <table ref={tableRef} aria-label={label} className="w-full border-collapse text-sm">
        <Ctx.Provider value={sortable ? { sort, onSort } : null}>{children}</Ctx.Provider>
      </table>
    </div>
  );
}

/**
 * A column header's label as a sort button, when its table sorts. Outside a
 * sortable table it is the plain label.
 */
export function SortButton({ children, numeric }: { children: ReactNode; numeric: boolean }) {
  const ctx = useContext(Ctx);
  const ref = useRef<HTMLButtonElement>(null);
  const [col, setCol] = useState<number | null>(null);

  useEffect(() => {
    const th = ref.current?.closest('th');
    if (!th) return;
    th.setAttribute('data-sortable', '');
    setCol(columnOf(th));
  }, [ctx]);

  if (!ctx) return <>{children}</>;
  const dir = col !== null && ctx.sort?.col === col ? ctx.sort.dir : null;
  // The mark sits in the header's padding, on the side away from the figures'
  // edge, so the label wraps exactly as it did before the column sorted.
  const mark = (
    // Drawn by CSS, so the header's text stays its label (copying, tests, readers).
    <span
      aria-hidden
      data-mark={dir === 'desc' ? '▼' : dir === 'asc' ? '▲' : '↕'}
      className={cx(
        'absolute top-1/2 w-2 -translate-y-1/2 text-center text-[0.65rem] before:content-[attr(data-mark)]',
        numeric ? '-left-3' : '-right-3',
        !dir && 'opacity-30',
      )}
    />
  );
  return (
    <button
      ref={ref}
      type="button"
      onClick={(e) => {
        const th = e.currentTarget.closest('th');
        if (th) ctx.onSort(columnOf(th));
      }}
      title={
        dir === null
          ? 'Sort low to high'
          : dir === 'asc'
            ? 'Sort high to low'
            : 'Back to the list order'
      }
      className={cx(
        'relative rounded font-[inherit] tracking-[inherit] [text-transform:inherit] hover:text-ink',
        numeric ? 'text-right' : 'text-left',
        dir && 'text-ink',
      )}
    >
      {numeric && mark}
      {children}
      {!numeric && mark}
    </button>
  );
}
