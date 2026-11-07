import { getMetric, SP500_SECTORS, type ScreenNumberColumn, type ScreenRow } from '@tm/domain';

/**
 * The stock screener's columns, filters, sorting and presets (ADR 0030).
 * Everything runs in the browser over the whole screen, so filtering and
 * sorting 12,000 rows never waits on the server.
 */

export type ColumnFormat = 'price' | 'pct' | 'volume' | 'money' | 'ratio';

export interface NumberColumnSpec {
  key: ScreenNumberColumn;
  label: string;
  /** Says how the value is worked out, in a tooltip and the column list. */
  hint: string;
  format: ColumnFormat;
  shown: boolean;
  /** From the company data feed (ADR 0031) rather than prices; hidden while no row has it. */
  company?: true;
}

export const NUMBER_COLUMNS: readonly NumberColumnSpec[] = [
  { key: 'last', label: 'Last price', hint: 'The latest trade', format: 'price', shown: true },
  {
    key: 'changePct',
    label: 'Today’s change %',
    hint: 'Last price against yesterday’s close',
    format: 'pct',
    shown: true,
  },
  {
    key: 'change',
    label: 'Today’s change $',
    hint: 'Last price minus yesterday’s close',
    format: 'price',
    shown: true,
  },
  { key: 'open', label: 'Today’s open', hint: 'First trade today', format: 'price', shown: true },
  {
    key: 'high',
    label: 'Today’s high',
    hint: 'Highest trade today',
    format: 'price',
    shown: false,
  },
  { key: 'low', label: 'Today’s low', hint: 'Lowest trade today', format: 'price', shown: false },
  {
    key: 'prevClose',
    label: 'Yesterday’s close',
    hint: 'Close of the session before today',
    format: 'price',
    shown: true,
  },
  {
    key: 'prevChangePct',
    label: 'Yesterday’s change %',
    hint: 'Yesterday’s close against the close the day before',
    format: 'pct',
    shown: true,
  },
  {
    key: 'gapPct',
    label: 'Opening gap %',
    hint: 'Today’s open against yesterday’s close',
    format: 'pct',
    shown: true,
  },
  {
    key: 'rangePct',
    label: 'Today’s range %',
    hint: 'Today’s high against today’s low',
    format: 'pct',
    shown: false,
  },
  {
    key: 'volume',
    label: 'Today’s volume',
    hint: 'Shares traded today so far',
    format: 'volume',
    shown: true,
  },
  {
    key: 'dollarVolume',
    label: 'Today’s $ volume',
    hint: 'Today’s volume times the last price',
    format: 'money',
    shown: false,
  },
  {
    key: 'avgVolume20',
    label: 'Avg volume (20 days)',
    hint: 'Average shares a day over the 20 sessions before today',
    format: 'volume',
    shown: false,
  },
  {
    key: 'relVolume',
    label: 'Relative volume',
    hint: 'Today’s volume so far against the 20-day average (2 = twice as much)',
    format: 'ratio',
    shown: true,
  },
  {
    key: 'change5dPct',
    label: '5-day change %',
    hint: 'Last price against the close 5 sessions ago',
    format: 'pct',
    shown: true,
  },
  {
    key: 'change1mPct',
    label: '1-month change %',
    hint: 'Last price against the close 21 sessions ago',
    format: 'pct',
    shown: true,
  },
  {
    key: 'high1m',
    label: '1-month high',
    hint: 'Highest price over the last 21 sessions, today included',
    format: 'price',
    shown: false,
  },
  {
    key: 'low1m',
    label: '1-month low',
    hint: 'Lowest price over the last 21 sessions, today included',
    format: 'price',
    shown: false,
  },
  {
    key: 'fromHigh1mPct',
    label: 'From 1-month high %',
    hint: 'Last price against the 1-month high (0 means at the high)',
    format: 'pct',
    shown: false,
  },
  {
    key: 'fromLow1mPct',
    label: 'From 1-month low %',
    hint: 'Last price against the 1-month low (0 means at the low)',
    format: 'pct',
    shown: false,
  },
  {
    key: 'marketCap',
    label: 'Market cap',
    hint: 'Last price times the diluted shares of the latest calendar year’s filings',
    format: 'money',
    shown: true,
    company: true,
  },
  {
    key: 'pe',
    label: 'P/E',
    hint: registryHint('pe'),
    format: 'ratio',
    shown: true,
    company: true,
  },
  {
    key: 'dividendYieldPct',
    label: 'Dividend yield %',
    hint: registryHint('dividend_yield'),
    format: 'pct',
    shown: true,
    company: true,
  },
  {
    key: 'priceToBook',
    label: 'Price-to-book',
    hint: registryHint('price_to_book'),
    format: 'ratio',
    shown: false,
    company: true,
  },
  {
    key: 'evEbitda',
    label: 'EV/EBITDA',
    hint: registryHint('ev_ebitda'),
    format: 'ratio',
    shown: false,
    company: true,
  },
  {
    key: 'revenue',
    label: 'Revenue',
    hint: 'Revenue for the latest calendar year, as filed',
    format: 'money',
    shown: false,
    company: true,
  },
  {
    key: 'revenueGrowthPct',
    label: 'Revenue growth %',
    hint: 'Revenue against the year before',
    format: 'pct',
    shown: false,
    company: true,
  },
  {
    key: 'netIncome',
    label: 'Net income',
    hint: 'Net income for the latest calendar year, as filed',
    format: 'money',
    shown: false,
    company: true,
  },
  {
    key: 'netMarginPct',
    label: 'Net margin %',
    hint: 'Net income over revenue',
    format: 'pct',
    shown: false,
    company: true,
  },
  {
    key: 'eps',
    label: 'EPS (diluted)',
    hint: 'Diluted earnings per share for the latest calendar year, as filed',
    format: 'price',
    shown: false,
    company: true,
  },
];

/** The metric registry's own definition, so the screener says what strategies compute (v1.2 item 6). */
function registryHint(metric: string): string {
  // The screener shows yields in percent, so the registry's "0.03 is 3%" note is left out.
  const help = (getMetric(metric)?.help ?? '').replace(/ \d\.\d+ is \d+%\.$/, '');
  return `${help} From the latest filings, as strategies read them.`;
}

/** Whether a screen carries any company figures, so the company columns are worth showing. */
export const hasCompanyFigures = (rows: readonly ScreenRow[] | null | undefined) =>
  !!rows?.some((r) => r.marketCap !== null || r.revenue !== null || r.eps !== null);

export const COLUMN_BY_KEY = new Map(NUMBER_COLUMNS.map((c) => [c.key, c]));

export type SortKey = ScreenNumberColumn | 'symbol' | 'name' | 'sector';

/** Which stocks a screen starts from: the S&P 500, or everything the feed covers. */
export type Universe = 'sp500' | 'all';

/** A stock's GICS sector, known for S&P 500 members only. */
export const sectorOf = (row: Pick<ScreenRow, 'symbol'>): string | null =>
  SP500_SECTORS.get(row.symbol) ?? null;

export const SECTORS: readonly string[] = [...new Set(SP500_SECTORS.values())].sort();
export interface SortState {
  key: SortKey;
  dir: 'asc' | 'desc';
}

export interface RangeFilter {
  min?: number | undefined;
  max?: number | undefined;
}

export interface ScreenFilters {
  /** Matches the start of the symbol or any word of the name. */
  text: string;
  type: 'all' | 'stock' | 'etf';
  exchange: string;
  /** A GICS sector; only S&P 500 members have one. */
  sector: string;
  ranges: Partial<Record<ScreenNumberColumn, RangeFilter>>;
}

export const EMPTY_FILTERS: ScreenFilters = {
  text: '',
  type: 'all',
  exchange: '',
  sector: '',
  ranges: {},
};
export const DEFAULT_SORT: SortState = { key: 'dollarVolume', dir: 'desc' };

/** Reads "1.5M", "250k", "2b", "1,000" or "-3.5" as a number; undefined when blank or not a number. */
export function parseAmount(raw: string): number | undefined {
  const s = raw.trim().replace(/,/g, '').replace(/^\+/, '').replace(/%$/, '');
  if (!s) return undefined;
  const m = /^(-?\d*\.?\d+)\s*([kmb])?$/i.exec(s);
  if (!m) return undefined;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] ?? '').toLowerCase() as 'k' | 'm' | 'b'] ?? 1;
  return Number(m[1]) * mult;
}

export function activeFilterCount(f: ScreenFilters): number {
  const ranges = Object.values(f.ranges).filter(
    (r) => r && (r.min !== undefined || r.max !== undefined),
  ).length;
  return (
    ranges +
    (f.text.trim() ? 1 : 0) +
    (f.type !== 'all' ? 1 : 0) +
    (f.exchange ? 1 : 0) +
    (f.sector ? 1 : 0)
  );
}

export function filterRows(
  rows: readonly ScreenRow[],
  f: ScreenFilters,
  universe: Universe = 'all',
): ScreenRow[] {
  const text = f.text.trim().toLowerCase();
  const upper = text.toUpperCase();
  const ranges = Object.entries(f.ranges).filter(
    (e): e is [ScreenNumberColumn, RangeFilter] =>
      !!e[1] && (e[1].min !== undefined || e[1].max !== undefined),
  );
  return rows.filter((r) => {
    if (universe === 'sp500' && !SP500_SECTORS.has(r.symbol)) return false;
    if (f.sector && sectorOf(r) !== f.sector) return false;
    if (f.type !== 'all' && r.assetClass !== f.type) return false;
    if (f.exchange && r.exchange !== f.exchange) return false;
    if (text && !r.symbol.startsWith(upper) && !` ${r.name.toLowerCase()}`.includes(` ${text}`)) {
      return false;
    }
    for (const [key, { min, max }] of ranges) {
      const v = r[key];
      // A value the screen does not have never passes a filter on it.
      if (v === null) return false;
      if (min !== undefined && v < min) return false;
      if (max !== undefined && v > max) return false;
    }
    return true;
  });
}

/** Sorts a copy; rows without the value go last either way. */
export function sortRows(rows: readonly ScreenRow[], sort: SortState): ScreenRow[] {
  const sign = sort.dir === 'asc' ? 1 : -1;
  const { key } = sort;
  return [...rows].sort((a, b) => {
    if (key === 'symbol' || key === 'name') {
      return sign * a[key].localeCompare(b[key]) || a.symbol.localeCompare(b.symbol);
    }
    if (key === 'sector') {
      const x = sectorOf(a);
      const y = sectorOf(b);
      if (x === y) return a.symbol.localeCompare(b.symbol);
      if (x === null) return 1;
      if (y === null) return -1;
      return sign * x.localeCompare(y);
    }
    const x = a[key];
    const y = b[key];
    if (x === null && y === null) return a.symbol.localeCompare(b.symbol);
    if (x === null) return 1;
    if (y === null) return -1;
    return sign * (x - y) || a.symbol.localeCompare(b.symbol);
  });
}

export interface ScreenPreset {
  id: string;
  label: string;
  filters: Omit<ScreenFilters, 'text' | 'exchange' | 'sector'>;
  sort: SortState;
}

/** Liquid enough to matter: at least 100,000 shares a day on average. */
const LIQUID: RangeFilter = { min: 100_000 };
const LIQUID_IEX: RangeFilter = { min: 5_000 };

export function screenPresets(iexVolumes: boolean): ScreenPreset[] {
  // IEX volumes are a few percent of the market's, so "liquid" means less there.
  const liquid = iexVolumes ? LIQUID_IEX : LIQUID;
  return [
    {
      id: 'gainers',
      label: 'Top gainers today',
      filters: { type: 'all', ranges: { changePct: { min: 0 }, avgVolume20: liquid } },
      sort: { key: 'changePct', dir: 'desc' },
    },
    {
      id: 'losers',
      label: 'Top losers today',
      filters: { type: 'all', ranges: { changePct: { max: 0 }, avgVolume20: liquid } },
      sort: { key: 'changePct', dir: 'asc' },
    },
    {
      id: 'active',
      label: 'Most active ($ volume)',
      filters: { type: 'all', ranges: {} },
      sort: { key: 'dollarVolume', dir: 'desc' },
    },
    {
      id: 'unusual-volume',
      label: 'Unusual volume (2× average)',
      filters: { type: 'all', ranges: { relVolume: { min: 2 }, avgVolume20: liquid } },
      sort: { key: 'relVolume', dir: 'desc' },
    },
    {
      id: 'gap-up',
      label: 'Gapped up 2% or more',
      filters: { type: 'all', ranges: { gapPct: { min: 2 }, avgVolume20: liquid } },
      sort: { key: 'gapPct', dir: 'desc' },
    },
    {
      id: 'gap-down',
      label: 'Gapped down 2% or more',
      filters: { type: 'all', ranges: { gapPct: { max: -2 }, avgVolume20: liquid } },
      sort: { key: 'gapPct', dir: 'asc' },
    },
    {
      id: 'month-high',
      label: 'At a 1-month high',
      filters: { type: 'all', ranges: { fromHigh1mPct: { min: -1 }, avgVolume20: liquid } },
      sort: { key: 'change1mPct', dir: 'desc' },
    },
  ];
}

// --- Formatting --------------------------------------------------------------

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

export function formatCell(value: number | null, format: ColumnFormat): string {
  if (value === null) return '—';
  switch (format) {
    case 'price':
      return value.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: Math.abs(value) < 1 ? 4 : 2,
      });
    case 'pct':
      return `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(2)}%`;
    case 'volume':
      return compact.format(value);
    case 'money':
      return value < 0 ? `−$${compact.format(-value)}` : `$${compact.format(value)}`;
    case 'ratio':
      return `${value.toFixed(2)}×`;
  }
}

/** Signed columns read as up or down; the sign is always written, so colour is a hint only. */
export function isSigned(key: ScreenNumberColumn): boolean {
  return (
    key === 'change' ||
    key === 'changePct' ||
    key === 'prevChangePct' ||
    key === 'gapPct' ||
    key === 'change5dPct' ||
    key === 'change1mPct' ||
    key === 'revenueGrowthPct'
  );
}

// --- CSV ---------------------------------------------------------------------

const csvCell = (v: string | number | null) => {
  if (v === null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(rows: readonly ScreenRow[], columns: readonly NumberColumnSpec[]): string {
  const header = ['Symbol', 'Name', 'Type', 'Exchange', 'Sector', ...columns.map((c) => c.label)];
  const lines = rows.map((r) =>
    [r.symbol, r.name, r.assetClass, r.exchange, sectorOf(r), ...columns.map((c) => r[c.key])]
      .map(csvCell)
      .join(','),
  );
  return [header.map(csvCell).join(','), ...lines].join('\n');
}

// --- Address -----------------------------------------------------------------

/**
 * Filters and sorting live in the address, so a screen can be bookmarked:
 * `sort=changePct.desc&f=changePct:2:,avgVolume20:100000:&q=bank&type=etf`.
 */
export function encodeScreenState(
  filters: ScreenFilters,
  sort: SortState,
  columns: readonly ScreenNumberColumn[] | null,
  universe: Universe = 'all',
  defaultUniverse: Universe = 'all',
): URLSearchParams {
  const q = new URLSearchParams();
  if (universe !== defaultUniverse) q.set('universe', universe);
  if (sort.key !== DEFAULT_SORT.key || sort.dir !== DEFAULT_SORT.dir) {
    q.set('sort', `${sort.key}.${sort.dir}`);
  }
  const ranges = Object.entries(filters.ranges)
    .filter(([, r]) => r && (r.min !== undefined || r.max !== undefined))
    .map(([k, r]) => `${k}:${r?.min ?? ''}:${r?.max ?? ''}`);
  if (ranges.length) q.set('f', ranges.join(','));
  if (filters.text.trim()) q.set('q', filters.text.trim());
  if (filters.type !== 'all') q.set('type', filters.type);
  if (filters.exchange) q.set('exchange', filters.exchange);
  if (filters.sector) q.set('sector', filters.sector);
  if (columns) q.set('cols', columns.join(','));
  return q;
}

export function decodeScreenState(
  q: URLSearchParams,
  defaultUniverse: Universe = 'all',
): {
  filters: ScreenFilters;
  sort: SortState;
  columns: ScreenNumberColumn[] | null;
  universe: Universe;
} {
  const [sortKey, sortDir] = (q.get('sort') ?? '').split('.');
  const validKey = (k: string | undefined): k is SortKey =>
    k === 'symbol' || k === 'name' || k === 'sector' || COLUMN_BY_KEY.has(k as ScreenNumberColumn);
  const sort: SortState =
    validKey(sortKey) && (sortDir === 'asc' || sortDir === 'desc')
      ? { key: sortKey, dir: sortDir }
      : DEFAULT_SORT;
  const ranges: ScreenFilters['ranges'] = {};
  for (const part of (q.get('f') ?? '').split(',')) {
    const [key, min, max] = part.split(':');
    if (!key || !COLUMN_BY_KEY.has(key as ScreenNumberColumn)) continue;
    const range = { min: parseAmount(min ?? ''), max: parseAmount(max ?? '') };
    if (range.min !== undefined || range.max !== undefined) {
      ranges[key as ScreenNumberColumn] = range;
    }
  }
  const type = q.get('type');
  const cols = (q.get('cols') ?? '')
    .split(',')
    .filter((c): c is ScreenNumberColumn => COLUMN_BY_KEY.has(c as ScreenNumberColumn));
  const universe = q.get('universe');
  const sector = q.get('sector') ?? '';
  return {
    sort,
    universe: universe === 'sp500' || universe === 'all' ? universe : defaultUniverse,
    filters: {
      text: (q.get('q') ?? '').slice(0, 60),
      type: type === 'stock' || type === 'etf' ? type : 'all',
      exchange: (q.get('exchange') ?? '').slice(0, 20),
      sector: SECTORS.includes(sector) ? sector : '',
      ranges,
    },
    columns: cols.length ? cols : null,
  };
}
