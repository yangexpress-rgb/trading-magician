/**
 * The stock screener in Quantitative Research (ADR 0030): one row of key
 * values per US stock or ETF the data feed covers, worked out the same way
 * whichever feed gave the prices. "Today" is the latest session with
 * prices (today's once the market opens; the last one on a weekend), and
 * "yesterday" the session before it.
 */

/** One session's prices for a symbol; the latest may still be trading. */
export interface ScreenDay {
  /** New York date of the session. */
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ScreenSource {
  symbol: string;
  name: string;
  assetClass: 'stock' | 'etf';
  exchange: string;
  /** The latest trade, when the feed has one; else the latest session's close. */
  last: number | null;
  lastAt: string | null;
  /** Oldest first, one per session, the latest possibly in progress. */
  days: ScreenDay[];
  /** Set when the instrument is already registered, so it can be charted at once. */
  instrumentId?: string | null;
}

/** Text columns of a screen row, then numeric ones, in wire order. */
export const SCREEN_TEXT_COLUMNS = ['symbol', 'name', 'assetClass', 'exchange'] as const;
export const SCREEN_NUMBER_COLUMNS = [
  'last',
  'change',
  'changePct',
  'open',
  'high',
  'low',
  'volume',
  'dollarVolume',
  'prevClose',
  'prevChangePct',
  'gapPct',
  'rangePct',
  'change5dPct',
  'change1mPct',
  'high1m',
  'low1m',
  'fromHigh1mPct',
  'fromLow1mPct',
  'avgVolume20',
  'relVolume',
] as const;
export type ScreenTextColumn = (typeof SCREEN_TEXT_COLUMNS)[number];
export type ScreenNumberColumn = (typeof SCREEN_NUMBER_COLUMNS)[number];
export type ScreenColumn = ScreenTextColumn | ScreenNumberColumn;

export type ScreenRow = Record<ScreenTextColumn, string> &
  Record<ScreenNumberColumn, number | null> & {
    lastAt: string | null;
    instrumentId: string | null;
  };

/**
 * A row on the wire: the text columns, the numeric columns, then `lastAt`
 * and `instrumentId`, in the orders above. About 12,000 rows stay near a
 * megabyte this way.
 */
export type ScreenRowTuple = (string | number | null)[];

/** Sessions in "a month" and in the average volume. */
export const SCREEN_MONTH_SESSIONS = 21;
export const SCREEN_VOLUME_SESSIONS = 20;
/** Calendar days of daily bars a screen needs: a month of sessions, holidays included. */
export const SCREEN_HISTORY_DAYS = 45;

const pct = (to: number | undefined | null, from: number | undefined | null) =>
  to == null || from == null || !(from > 0) ? null : round(((to - from) / from) * 100, 2);
const round = (n: number, places: number) => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};
const price = (n: number | undefined | null) => (n == null ? null : round(n, 4));

/**
 * Works out a symbol's row. `session` is the screen's "today": a symbol that
 * has not traded in it has no today values, and its latest close is
 * yesterday's.
 */
export function screenRow(source: ScreenSource, session: string): ScreenRow {
  const days = source.days.filter((d) => d.date <= session);
  const latest = days.at(-1);
  const today = latest?.date === session ? latest : undefined;
  const before = today ? days.slice(0, -1) : days;
  const prev = before.at(-1);
  const prevPrev = before.at(-2);
  const last = today ? (source.last ?? today.close) : (prev?.close ?? null);
  const monthDays = days.slice(-SCREEN_MONTH_SESSIONS);
  const high1m = monthDays.length ? Math.max(...monthDays.map((d) => d.high)) : null;
  const low1m = monthDays.length ? Math.min(...monthDays.map((d) => d.low)) : null;
  // Closes N sessions before today, counting yesterday as one.
  const closeAgo = (n: number) => before.at(-n)?.close;
  const volumes = before.slice(-SCREEN_VOLUME_SESSIONS).map((d) => d.volume);
  const avgVolume = volumes.length
    ? Math.round(volumes.reduce((a, b) => a + b, 0) / volumes.length)
    : null;
  const volume = today ? today.volume : null;
  return {
    symbol: source.symbol,
    name: source.name,
    assetClass: source.assetClass,
    exchange: source.exchange,
    last: price(last),
    change: today && last != null && prev ? price(last - prev.close) : null,
    changePct: today ? pct(last, prev?.close) : null,
    open: price(today?.open),
    high: price(today?.high),
    low: price(today?.low),
    volume,
    dollarVolume: volume != null && last != null ? Math.round(volume * last) : null,
    prevClose: price(prev?.close),
    prevChangePct: pct(prev?.close, prevPrev?.close),
    gapPct: today ? pct(today.open, prev?.close) : null,
    rangePct: today ? pct(today.high, today.low) : null,
    change5dPct: pct(last, closeAgo(5)),
    change1mPct: pct(last, closeAgo(SCREEN_MONTH_SESSIONS)),
    high1m: price(high1m),
    low1m: price(low1m),
    fromHigh1mPct: pct(last, high1m),
    fromLow1mPct: pct(last, low1m),
    avgVolume20: avgVolume,
    relVolume:
      volume != null && avgVolume != null && avgVolume > 0 ? round(volume / avgVolume, 2) : null,
    lastAt: today ? source.lastAt : null,
    instrumentId: source.instrumentId ?? null,
  };
}

/** The screen's "today": the latest session any symbol has prices for. */
export function screenSession(sources: readonly ScreenSource[]): string | null {
  let latest: string | null = null;
  for (const s of sources) {
    const d = s.days.at(-1)?.date;
    if (d && (!latest || d > latest)) latest = d;
  }
  return latest;
}

export function toScreenTuple(row: ScreenRow): ScreenRowTuple {
  return [
    ...SCREEN_TEXT_COLUMNS.map((c) => row[c]),
    ...SCREEN_NUMBER_COLUMNS.map((c) => row[c]),
    row.lastAt,
    row.instrumentId,
  ];
}

export function fromScreenTuple(tuple: ScreenRowTuple): ScreenRow {
  const row = {} as ScreenRow;
  let i = 0;
  for (const c of SCREEN_TEXT_COLUMNS) row[c] = String(tuple[i++] ?? '');
  for (const c of SCREEN_NUMBER_COLUMNS) {
    const v = tuple[i++];
    row[c] = typeof v === 'number' && Number.isFinite(v) ? v : null;
  }
  const lastAt = tuple[i++];
  const instrumentId = tuple[i++];
  row.lastAt = typeof lastAt === 'string' ? lastAt : null;
  row.instrumentId = typeof instrumentId === 'string' ? instrumentId : null;
  return row;
}
