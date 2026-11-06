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
}

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

/** CBOE's free daily history files, one CSV per index. */
export const CBOE_HISTORY_URL = 'https://cdn.cboe.com/api/global/us_indices/daily_prices';

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
 * Parses CBOE's history CSV: a `DATE,OPEN,HIGH,LOW,CLOSE` header and dates
 * written MM/DD/YYYY. Rows that don't parse are skipped and counted. Early
 * rows with only a close (before 1992) keep the close as the open, high and
 * low, so the bar is flat rather than zero.
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
    days.push({
      date: `${m[3]}-${(m[1] ?? '').padStart(2, '0')}-${(m[2] ?? '').padStart(2, '0')}`,
      open: pick(iOpen),
      high: pick(iHigh),
      low: pick(iLow),
      close,
    });
  }
  days.sort((a, b) => a.date.localeCompare(b.date));
  // A date written twice: the later row wins.
  const unique = days.filter((d, i) => days[i + 1]?.date !== d.date);
  return { days: unique, skipped };
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
    const high = Decimal.max(d.high, d.open, d.close);
    const low = Decimal.min(d.low, d.open, d.close);
    bars.push({
      start: session.open,
      end: session.close,
      open: new Decimal(d.open),
      high,
      low,
      close: new Decimal(d.close),
      volume: new Decimal(0),
    });
  }
  return { bars, dropped };
}
