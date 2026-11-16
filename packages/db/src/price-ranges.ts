import type { YearRange } from '@tm/domain';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Database, Transaction } from './client';
import { instruments, priceRanges52w } from './schema';

/**
 * Stored 52-week lows and highs (N290, ADR 0099). Global market data, like
 * the factor store: the worker writes a row per stock after each close, and
 * the app reads them for the screener and Price charts.
 */

type Db = Database | Transaction;

const CHUNK = 1000;

/**
 * Every registered US stock and ETF (not demo, not an index): the members of
 * the built-in stock groups, and any stock someone has looked up, charted or
 * traded. Their figures are kept up to date.
 */
export async function priceRangeMembers(db: Db): Promise<string[]> {
  const rows = await db
    .select({ id: instruments.id })
    .from(instruments)
    .where(
      and(
        inArray(instruments.assetClass, ['stock', 'etf']),
        eq(instruments.isDemo, false),
        eq(instruments.kind, 'tradable'),
        ne(instruments.venue, 'DEMO'),
      ),
    );
  return rows.map((r) => r.id);
}

/** The session each instrument's stored figures are as of (absent: none yet). */
export async function priceRangeDates(
  db: Db,
  instrumentIds: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < instrumentIds.length; i += CHUNK) {
    const ids = instrumentIds.slice(i, i + CHUNK);
    const rows = await db
      .select({ id: priceRanges52w.instrumentId, asOf: priceRanges52w.asOf })
      .from(priceRanges52w)
      .where(inArray(priceRanges52w.instrumentId, ids));
    for (const r of rows) out.set(r.id, r.asOf);
  }
  return out;
}

/** Writes each instrument's figures, replacing older ones (never with an older session's). */
export async function savePriceRanges(
  db: Db,
  rows: readonly { instrumentId: string; range: YearRange }[],
): Promise<number> {
  let written = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const values = rows.slice(i, i + CHUNK).map(({ instrumentId, range: r }) => ({
      instrumentId,
      asOf: r.asOf,
      close: r.close,
      low: r.low.price,
      lowOn: r.low.on,
      lowDays: r.low.days,
      high: r.high.price,
      highOn: r.high.on,
      highDays: r.high.days,
      tailLow: r.tailLow.price,
      tailLowOn: r.tailLow.on,
      tailLowDays: r.tailLow.days,
      tailHigh: r.tailHigh.price,
      tailHighOn: r.tailHigh.on,
      tailHighDays: r.tailHigh.days,
    }));
    if (values.length === 0) continue;
    const out = await db
      .insert(priceRanges52w)
      .values(values)
      .onConflictDoUpdate({
        target: priceRanges52w.instrumentId,
        set: {
          asOf: sql`excluded.as_of`,
          close: sql`excluded.close`,
          low: sql`excluded.low`,
          lowOn: sql`excluded.low_on`,
          lowDays: sql`excluded.low_days`,
          high: sql`excluded.high`,
          highOn: sql`excluded.high_on`,
          highDays: sql`excluded.high_days`,
          tailLow: sql`excluded.tail_low`,
          tailLowOn: sql`excluded.tail_low_on`,
          tailLowDays: sql`excluded.tail_low_days`,
          tailHigh: sql`excluded.tail_high`,
          tailHighOn: sql`excluded.tail_high_on`,
          tailHighDays: sql`excluded.tail_high_days`,
          updatedAt: sql`now()`,
        },
        // A same-day recompute (e.g. after a split) replaces; an older session never does.
        setWhere: sql`${priceRanges52w.asOf} <= excluded.as_of`,
      })
      .returning({ id: priceRanges52w.instrumentId });
    written += out.length;
  }
  return written;
}

type RangeRow = typeof priceRanges52w.$inferSelect;

const toRange = (r: RangeRow): YearRange => ({
  asOf: r.asOf,
  close: r.close,
  low: { price: r.low, on: r.lowOn, days: r.lowDays },
  high: { price: r.high, on: r.highOn, days: r.highDays },
  tailLow: { price: r.tailLow, on: r.tailLowOn, days: r.tailLowDays },
  tailHigh: { price: r.tailHigh, on: r.tailHighOn, days: r.tailHighDays },
});

/** One instrument's stored figures, if any. */
export async function loadPriceRange(db: Db, instrumentId: string): Promise<YearRange | null> {
  const [row] = await db
    .select()
    .from(priceRanges52w)
    .where(eq(priceRanges52w.instrumentId, instrumentId));
  return row ? toRange(row) : null;
}

/** Every stored figure, by instrument id and by symbol, for a screen's rows. */
export async function loadPriceRanges(
  db: Db,
): Promise<{ byId: Map<string, YearRange>; bySymbol: Map<string, YearRange> }> {
  const rows = await db
    .select({ range: priceRanges52w, symbol: instruments.symbol })
    .from(priceRanges52w)
    .innerJoin(instruments, eq(instruments.id, priceRanges52w.instrumentId));
  const byId = new Map<string, YearRange>();
  const bySymbol = new Map<string, YearRange>();
  for (const { range, symbol } of rows) {
    const r = toRange(range);
    byId.set(range.instrumentId, r);
    bySymbol.set(symbol, r);
  }
  return { byId, bySymbol };
}
