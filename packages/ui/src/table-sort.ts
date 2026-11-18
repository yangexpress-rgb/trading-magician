/**
 * Sorting a report table by a column (N303). The rows are read and reordered
 * in the page itself, so any list built from `Table` sorts without each list
 * having to know its own sort keys. These are the pure parts: reading a cell's
 * value and putting rows in order.
 */

export type SortDir = 'asc' | 'desc';
export type TableSort = { col: number; dir: SortDir };

/** A cell's sort value: a number (amounts, counts, dates), text, or nothing. */
export type CellValue = number | string | null;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const SCALE: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };

/** Signs as the app prints them: a true minus and the en dash count as minus. */
function plainSigns(text: string): string {
  return text.replace(/[−–]/g, '-');
}

/** Time of day "10:31", "10:31:05", "10:31 AM" in minutes past midnight, or 0. */
function minutesOf(time: string | undefined): number {
  if (!time) return 0;
  const m = /(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?m\.?)?/i.exec(time);
  if (!m) return 0;
  let h = Number(m[1]) % 24;
  const pm = m[4]?.toLowerCase().startsWith('p');
  if (m[4]) h = (h % 12) + (pm ? 12 : 0);
  return h * 60 + Number(m[2]) + Number(m[3] ?? 0) / 60;
}

/**
 * A date as the app prints it, in milliseconds (local time), or null:
 * "Nov 18, 2026", "Nov 18, 2026, 10:31 AM", "18 Nov 2026 10:31",
 * "2026-11-18", "2026-11-18 10:31", "11/18/2026". A date without a year
 * ("Nov 18 10:31") takes `year`.
 */
export function parseDate(text: string, year = new Date().getFullYear()): number | null {
  const t = text.trim();
  let y: number;
  let mo: number;
  let d: number;
  let rest: string | undefined;
  let m = /^(\d{4})-(\d{2})-(\d{2})(.*)$/.exec(t);
  if (m) {
    [y, mo, d, rest] = [Number(m[1]), Number(m[2]) - 1, Number(m[3]), m[4]];
  } else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(.*)$/.exec(t))) {
    [y, mo, d, rest] = [Number(m[3]), Number(m[1]) - 1, Number(m[2]), m[4]];
  } else if (
    (m = /^(?:[a-z]{3},?\s+)?([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?(.*)$/i.exec(t))
  ) {
    mo = MONTHS.indexOf((m[1] ?? '').toLowerCase());
    [y, d, rest] = [m[3] ? Number(m[3]) : year, Number(m[2]), m[4]];
  } else if (
    (m = /^(?:[a-z]{3},?\s+)?(\d{1,2})\s+([a-z]{3})[a-z]*\.?(?:,?\s+(\d{4}))?(.*)$/i.exec(t))
  ) {
    mo = MONTHS.indexOf((m[2] ?? '').toLowerCase());
    [y, d, rest] = [m[3] ? Number(m[3]) : year, Number(m[1]), m[4]];
  } else {
    return null;
  }
  if (mo < 0 || mo > 11 || d < 1 || d > 31) return null;
  // Only a time of day may follow the date; anything else is not a date.
  if (
    rest &&
    !/^[,\sT]*(\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\s*([ap]\.?m\.?)?)?\s*(Z|[A-Z]{2,4}|[+-]\d{2}:?\d{2})?\s*$/i.test(
      rest,
    )
  ) {
    return null;
  }
  return new Date(y, mo, d).getTime() + minutesOf(rest) * 60_000;
}

/**
 * The number a cell starts with: "+$524.68", "−$1,573.26", "+0.55% of
 * $49,850.21", "4", "1.2M", "($3.10)". Null when the text does not start
 * with a number.
 */
export function parseNumber(text: string): number | null {
  const t = plainSigns(text.trim());
  const m = /^(\()?([+-])?\s*\$?\s*(\d[\d,]*(?:\.\d+)?|\.\d+)\s*([kmbt](?![a-z]))?/i.exec(t);
  if (!m) return null;
  const n = Number((m[3] ?? '').replace(/,/g, '')) * (m[4] ? (SCALE[m[4].toLowerCase()] ?? 1) : 1);
  return m[2] === '-' || (m[1] && t.includes(')')) ? -n : n;
}

/** What a cell shows when it has no value: blank, a dash, "n/a". */
export function isBlank(text: string): boolean {
  return /^[\s\-−–—]*$|^(n\/?a|none|not set|not specified)$/i.test(text.trim());
}

/**
 * The values of one column, made comparable: numbers when every filled cell
 * is a number, else dates when every filled cell is a date, else text.
 */
export function columnValues(texts: readonly (string | null)[]): CellValue[] {
  const filled = texts.map((t) => (t === null || isBlank(t) ? null : t.trim()));
  const nums = filled.map((t) => (t === null ? null : parseNumber(t)));
  if (filled.every((t, i) => t === null || nums[i] !== null)) return nums;
  const dates = filled.map((t) => (t === null ? null : parseDate(t)));
  if (filled.every((t, i) => t === null || dates[i] !== null)) return dates;
  return filled;
}

const collator = new Intl.Collator('en-US', { numeric: true, sensitivity: 'base' });

/** Compares two values; empty cells always go last whichever way the column sorts. */
export function compareValues(a: CellValue, b: CellValue, dir: SortDir): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const sign = dir === 'asc' ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return sign * (a - b);
  return sign * collator.compare(String(a), String(b));
}

/**
 * The order to show rows in, as indexes into `values` (one value per row).
 * Ties keep their current order.
 */
export function sortedOrder(values: readonly CellValue[], dir: SortDir): number[] {
  return values
    .map((v, i) => ({ v, i }))
    .sort((x, y) => compareValues(x.v, y.v, dir) || x.i - y.i)
    .map((x) => x.i);
}

/** A header click: first low to high, then high to low, then back to the list's own order. */
export function nextSort(current: TableSort | null, col: number): TableSort | null {
  if (current?.col !== col) return { col, dir: 'asc' };
  return current.dir === 'asc' ? { col, dir: 'desc' } : null;
}

/** A remembered sort, or null when what was stored is not one. */
export function parseSort(raw: string | null): TableSort | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<TableSort>;
    const col = v.col;
    return typeof col === 'number' &&
      Number.isInteger(col) &&
      col >= 0 &&
      (v.dir === 'asc' || v.dir === 'desc')
      ? { col, dir: v.dir }
      : null;
  } catch {
    return null;
  }
}
