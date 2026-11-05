import type { CompanyMetrics, FiscalYearField } from '@tm/domain';

/** Words and number formats for the company section in Quantitative Research (ADR 0031). */

const compact = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
});

/** $416.16B, −$1.2M; a dash when the filings don't say. */
export function formatMoney(value: number | null | undefined): string {
  if (value == null) return '—';
  return value < 0 ? `−$${compact.format(-value)}` : `$${compact.format(value)}`;
}

export function formatPerShare(value: number | null | undefined): string {
  if (value == null) return '—';
  const s = Math.abs(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return value < 0 ? `−$${s}` : `$${s}`;
}

export function formatCount(value: number | null | undefined): string {
  return value == null ? '—' : compact.format(value);
}

export function formatPct(value: number | null | undefined, signed = false): string {
  if (value == null) return '—';
  const sign = value < 0 ? '−' : signed && value > 0 ? '+' : '';
  return `${sign}${Math.abs(value).toFixed(1)}%`;
}

export function formatMultiple(value: number | null | undefined): string {
  return value == null ? '—' : `${value.toFixed(value >= 100 ? 0 : 1)}×`;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** "09-27" → "September 27". */
export function formatMonthDay(mmdd: string | null): string | null {
  const m = mmdd ? /^(\d{2})-(\d{2})$/.exec(mmdd) : null;
  if (!m) return null;
  const month = MONTHS[Number(m[1]) - 1];
  return month ? `${month} ${Number(m[2])}` : null;
}

/** "2025-10-31" → "Oct 31, 2025", read as a calendar date with no time zone. */
export function formatDay(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'UTC',
      });
}

export interface StatementLine {
  key: FiscalYearField;
  label: string;
  format: 'money' | 'perShare' | 'count';
}

/** The annual table, top to bottom: income, cash flow, then the year-end balance sheet. */
export const STATEMENT_LINES: readonly { group: string; lines: readonly StatementLine[] }[] = [
  {
    group: 'Income',
    lines: [
      { key: 'revenue', label: 'Revenue', format: 'money' },
      { key: 'grossProfit', label: 'Gross profit', format: 'money' },
      { key: 'operatingIncome', label: 'Operating income', format: 'money' },
      { key: 'netIncome', label: 'Net income', format: 'money' },
      { key: 'eps', label: 'EPS (diluted)', format: 'perShare' },
      { key: 'dividendsPerShare', label: 'Dividends per share', format: 'perShare' },
      { key: 'dilutedShares', label: 'Diluted shares', format: 'count' },
    ],
  },
  {
    group: 'Cash flow',
    lines: [
      { key: 'operatingCashFlow', label: 'Operating cash flow', format: 'money' },
      { key: 'capitalExpenditure', label: 'Capital spending', format: 'money' },
    ],
  },
  {
    group: 'Balance sheet (year end)',
    lines: [
      { key: 'cash', label: 'Cash', format: 'money' },
      { key: 'totalAssets', label: 'Total assets', format: 'money' },
      { key: 'totalLiabilities', label: 'Total liabilities', format: 'money' },
      { key: 'longTermDebt', label: 'Long-term debt', format: 'money' },
      { key: 'equity', label: 'Shareholders’ equity', format: 'money' },
    ],
  },
];

export const formatLine = (value: number | null, format: StatementLine['format']) =>
  format === 'money'
    ? formatMoney(value)
    : format === 'perShare'
      ? formatPerShare(value)
      : formatCount(value);

/** The key figures, in reading order, with how each is worked out. */
export const KEY_FIGURES: readonly {
  key: keyof CompanyMetrics;
  label: string;
  hint: string;
  format: 'money' | 'pct' | 'signedPct' | 'multiple';
}[] = [
  {
    key: 'marketCap',
    label: 'Market cap',
    hint: 'Last price times the shares outstanding on the latest filing’s cover',
    format: 'money',
  },
  {
    key: 'pe',
    label: 'P/E',
    hint: 'Last price over the latest fiscal year’s diluted EPS; blank when earnings are not positive',
    format: 'multiple',
  },
  {
    key: 'ps',
    label: 'Price / sales',
    hint: 'Market cap over the latest year’s revenue',
    format: 'multiple',
  },
  {
    key: 'pb',
    label: 'Price / book',
    hint: 'Market cap over year-end shareholders’ equity',
    format: 'multiple',
  },
  {
    key: 'revenueGrowthPct',
    label: 'Revenue growth',
    hint: 'Latest fiscal year’s revenue against the year before',
    format: 'signedPct',
  },
  {
    key: 'grossMarginPct',
    label: 'Gross margin',
    hint: 'Gross profit over revenue',
    format: 'pct',
  },
  {
    key: 'operatingMarginPct',
    label: 'Operating margin',
    hint: 'Operating income over revenue',
    format: 'pct',
  },
  { key: 'netMarginPct', label: 'Net margin', hint: 'Net income over revenue', format: 'pct' },
  {
    key: 'roePct',
    label: 'Return on equity',
    hint: 'Net income over year-end shareholders’ equity',
    format: 'pct',
  },
  {
    key: 'debtToEquity',
    label: 'Debt / equity',
    hint: 'Long-term debt over shareholders’ equity',
    format: 'multiple',
  },
  {
    key: 'freeCashFlow',
    label: 'Free cash flow',
    hint: 'Operating cash flow minus capital spending',
    format: 'money',
  },
  {
    key: 'dividendYieldPct',
    label: 'Dividend yield',
    hint: 'Dividends declared per share in the latest fiscal year over the last price',
    format: 'pct',
  },
];

export function formatFigure(
  value: number | null,
  format: (typeof KEY_FIGURES)[number]['format'],
): string {
  switch (format) {
    case 'money':
      return formatMoney(value);
    case 'pct':
      return formatPct(value);
    case 'signedPct':
      return formatPct(value, true);
    case 'multiple':
      return formatMultiple(value);
  }
}
