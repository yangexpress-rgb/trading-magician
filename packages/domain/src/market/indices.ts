import Decimal from 'decimal.js';
import type { Bar } from './bars';
import { regularSession } from './calendar';

/**
 * Indicator-only instruments (Design v1.2 item 5, ADR 0042): indices such as
 * the CBOE Volatility Index that a strategy can watch but never trade. They
 * have the asset class `index` and the kind `indicator_only`; conditions,
 * ranking metrics and calculated expressions may read them, but no leg can
 * trade them, no order names them and no broker account routes them.
 */

/** The asset class of an index; every instrument of it is indicator-only. */
export const INDEX_ASSET_CLASS = 'index';

export type InstrumentKind = 'tradable' | 'indicator_only';

/** The badge shown wherever an indicator-only instrument appears. */
export const INDEX_BADGE = 'Index — not tradable';

/** Whether instruments of an asset class can only be watched, never traded. */
export function isIndicatorOnlyClass(assetClass: string): boolean {
  return assetClass === INDEX_ASSET_CLASS;
}

export interface IndexListing {
  symbol: string;
  displayName: string;
  venue: string;
  /** The provider whose feed carries its history, and its id there. */
  provider: string;
  providerId: string;
  /** What a person might type for it, upper case. */
  aliases: readonly string[];
  /** FRED's daily close series for it, the fallback when the provider is unreachable. */
  fredSeries?: string;
  /** The data owner's display terms for it (see `IndexDataTerms`). */
  terms: IndexDataTerms;
}

/**
 * Licensing flag for an index's data (v1.2 review). CBOE owns the VIX: its
 * free history files and FRED's VIXCLS copy are published for display, but
 * showing them to paying customers or redistributing them (CSV exports
 * included) may need a Cboe data licence. `reviewed` stays false until
 * someone has read Cboe's current display terms for this use; the launch
 * checks (docs/launch-checks.md) list it, and every series carries `attribution`.
 */
export interface IndexDataTerms {
  owner: string;
  attribution: string;
  /** Whether Cboe's display terms have been reviewed for the app's use. */
  reviewed: boolean;
  note: string;
}

export const CBOE_DISPLAY_TERMS: IndexDataTerms = {
  owner: 'Cboe Global Markets',
  attribution: 'Source: Cboe Global Markets',
  reviewed: false,
  note:
    "Cboe's display terms for its free index history have not been reviewed for a paid service " +
    'or for redistribution. Review them, or license the data, before charging for VIX-based features.',
};

/**
 * The indices the app knows. VIX first: CBOE publishes its daily history for
 * free. Searching "VIX" finds this listing, never a VIX-futures ETF such as
 * VIXY or UVXY, which are different things with different values.
 */
export const INDEX_LISTINGS: readonly IndexListing[] = [
  {
    symbol: 'VIX',
    displayName: 'CBOE Volatility Index',
    venue: 'CBOE',
    provider: 'cboe',
    providerId: 'VIX',
    aliases: ['VIX', '^VIX', '$VIX', 'CBOE VIX', 'VOLATILITY INDEX', 'CBOE VOLATILITY INDEX'],
    fredSeries: 'VIXCLS',
    terms: CBOE_DISPLAY_TERMS,
  },
];

/** The index a search text names, if any: its symbol, an alias, or a word of its name. */
export function findIndexListing(text: string): IndexListing | undefined {
  const q = text.trim().toUpperCase().replace(/\s+/g, ' ');
  if (!q) return undefined;
  return INDEX_LISTINGS.find(
    (l) =>
      l.aliases.includes(q) ||
      (q.length >= 4 && l.displayName.toUpperCase().includes(q) && /VOLATILITY|VIX/.test(q)),
  );
}

export function indexListingBySymbol(symbol: string): IndexListing | undefined {
  return INDEX_LISTINGS.find((l) => l.symbol === symbol);
}

// ---------------------------------------------------------------------------
// CBOE daily history

/** CBOE's free daily history files, one CSV per index; the worker's `CBOE_HISTORY_URL` overrides it. */
export const CBOE_HISTORY_URL = 'https://cdn.cboe.com/api/global/us_indices/daily_prices';

/** FRED's CSV download for a series; the worker's `FRED_CSV_URL` overrides it. */
export const FRED_CSV_URL = 'https://fred.stlouisfed.org/graph/fredgraph.csv';

export const fredSeriesQuery = (series: string) => `?id=${encodeURIComponent(series)}`;

export const cboeHistoryPath = (symbol: string) => `/${symbol}_History.csv`;

export interface CboeDay {
  /** `YYYY-MM-DD`. */
  date: string;
  open: string;
  high: string;
  low: string;
  close: string;
}

const NUMBER = /^-?\d+(\.\d+)?$/;

/**
 * Whether a day's candle is possible: the high is the highest of open, low
 * and close, and the low the lowest. A row that breaks this is a bad row,
 * not a bar to repair.
 */
export function isPossibleCandle(d: CboeDay): boolean {
  const [o, h, l, c] = [d.open, d.high, d.low, d.close].map(Number) as [
    number,
    number,
    number,
    number,
  ];
  return h >= o && h >= c && h >= l && l <= o && l <= c;
}

/**
 * Parses CBOE's history CSV: a `DATE,OPEN,HIGH,LOW,CLOSE` header and dates
 * written MM/DD/YYYY. Rows that don't parse, and rows with an impossible
 * candle (a high below the close, a low above the open, ...), are skipped and
 * counted. Early rows with only a close (before 1992) keep the close as the
 * open, high and low, so the bar is flat rather than zero.
 */
export function parseCboeHistory(csv: string): { days: CboeDay[]; skipped: number } {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== '');
  const header = (lines.shift() ?? '')
    .toUpperCase()
    .split(',')
    .map((h) => h.trim());
  const col = (name: string) => header.indexOf(name);
  const [iDate, iOpen, iHigh, iLow, iClose] = ['DATE', 'OPEN', 'HIGH', 'LOW', 'CLOSE'].map(col);
  if (iDate === undefined || iDate < 0 || iClose === undefined || iClose < 0) {
    throw new Error('The CBOE file has no DATE and CLOSE columns');
  }
  const days: CboeDay[] = [];
  let skipped = 0;
  for (const line of lines) {
    const cells = line.split(',').map((c) => c.trim());
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(cells[iDate] ?? '');
    const close = cells[iClose] ?? '';
    if (!m || !NUMBER.test(close) || Number(close) <= 0) {
      skipped++;
      continue;
    }
    const pick = (i: number | undefined) => {
      const v = i !== undefined && i >= 0 ? (cells[i] ?? '') : '';
      return NUMBER.test(v) && Number(v) > 0 ? v : close;
    };
    const day = {
      date: `${m[3]}-${(m[1] ?? '').padStart(2, '0')}-${(m[2] ?? '').padStart(2, '0')}`,
      open: pick(iOpen),
      high: pick(iHigh),
      low: pick(iLow),
      close,
    };
    if (!isPossibleCandle(day)) {
      skipped++;
      continue;
    }
    days.push(day);
  }
  return { days: uniqueDays(days), skipped };
}

function uniqueDays(days: CboeDay[]): CboeDay[] {
  days.sort((a, b) => a.date.localeCompare(b.date));
  // A date written twice: the later row wins.
  return days.filter((d, i) => days[i + 1]?.date !== d.date);
}

/**
 * Parses a FRED series CSV (`observation_date,<SERIES>` or the older
 * `DATE,<SERIES>`, dates YYYY-MM-DD, a blank or "." for a day with no value).
 * FRED has closes only, so each day is a flat bar: open, high and low equal
 * the close.
 */
export function parseFredSeries(csv: string): { days: CboeDay[]; skipped: number } {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== '');
  const header = (lines.shift() ?? '').split(',').map((h) => h.trim().toUpperCase());
  if (header.length < 2 || !/^(OBSERVATION_DATE|DATE)$/.test(header[0] ?? '')) {
    throw new Error('The FRED file has no date column');
  }
  const days: CboeDay[] = [];
  let skipped = 0;
  for (const line of lines) {
    const [date = '', value = ''] = line.split(',').map((c) => c.trim());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      skipped++;
      continue;
    }
    // A holiday or a day without a value: no bar, nothing wrong.
    if (value === '' || value === '.') continue;
    if (!NUMBER.test(value) || Number(value) <= 0) {
      skipped++;
      continue;
    }
    days.push({ date, open: value, high: value, low: value, close: value });
  }
  return { days: uniqueDays(days), skipped };
}

/**
 * Daily bars from CBOE days, aligned to the US trading calendar (v1.2 item 5):
 * each bar spans that day's NYSE regular session, so it lines up with every
 * stock's daily bar. A value published on a day the exchange is closed is
 * dropped; a trading day CBOE has no value for simply has no bar, and the
 * engine then reads the most recent close on or before that day.
 */
export function cboeBars(
  days: readonly CboeDay[],
  from: string,
  to: string,
  now: Date,
): { bars: Bar[]; dropped: string[] } {
  const bars: Bar[] = [];
  const dropped: string[] = [];
  for (const d of days) {
    if (d.date < from || d.date > to) continue;
    const session = regularSession(d.date);
    if (!session) {
      dropped.push(d.date);
      continue;
    }
    if (Date.parse(session.close) > now.getTime()) continue;
    // Impossible candles were refused when the file was read.
    bars.push({
      start: session.open,
      end: session.close,
      open: new Decimal(d.open),
      high: new Decimal(d.high),
      low: new Decimal(d.low),
      close: new Decimal(d.close),
      volume: new Decimal(0),
    });
  }
  return { bars, dropped };
}
