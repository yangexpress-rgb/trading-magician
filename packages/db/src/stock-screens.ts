import type { ScreenRowTuple } from '@tm/domain';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Database, Transaction } from './client';
import { IntegrationError } from './feeds';
import { stockScreens } from './schema';

/**
 * Stock screens for Quantitative Research (ADR 0030). Prices for every US
 * stock and ETF come through the tenant's data feed, which only the worker
 * can open, so the web app queues a screen and polls it; the worker stores
 * one row of key values per symbol on it.
 */

export type StockScreenStatus = 'pending' | 'ready' | 'failed';

export interface StockScreenSummary {
  id: string;
  status: StockScreenStatus;
  /** New York date of the session the screen calls today. */
  sessionDate: string | null;
  rowCount: number | null;
  message: string | null;
  source: string | null;
  warnings: string[];
  createdAt: string;
  updatedAt: string;
}

export interface StockScreenData extends StockScreenSummary {
  rows: ScreenRowTuple[] | null;
}

/** A ready screen this recent is shown again instead of asking the feed. */
export const SCREEN_REUSE_SECONDS = 60;

/** Starts a screen, or hands back the one in progress or from the last minute. */
export async function requestStockScreen(
  tx: Transaction,
  input: { userId: string; fresh?: boolean | undefined },
): Promise<StockScreenSummary> {
  const [recent] = await tx
    .select({ id: stockScreens.id })
    .from(stockScreens)
    .where(
      input.fresh
        ? eq(stockScreens.status, 'pending')
        : sql`(${stockScreens.status} = 'pending' OR (${stockScreens.status} = 'ready' AND ${stockScreens.createdAt} > now() - make_interval(secs => ${SCREEN_REUSE_SECONDS})))`,
    )
    .orderBy(desc(stockScreens.createdAt))
    .limit(1);
  if (recent) return getStockScreen(tx, recent.id);
  const [row] = await tx
    .insert(stockScreens)
    .values({ userId: input.userId })
    .returning({ id: stockScreens.id });
  if (!row) throw new Error('stock screen insert failed');
  return getStockScreen(tx, row.id);
}

const summaryColumns = {
  id: stockScreens.id,
  status: stockScreens.status,
  sessionDate: stockScreens.sessionDate,
  rowCount: stockScreens.rowCount,
  message: stockScreens.message,
  source: stockScreens.source,
  warnings: stockScreens.warnings,
  createdAt: stockScreens.createdAt,
  updatedAt: stockScreens.updatedAt,
};

function toSummary(row: {
  id: string;
  status: StockScreenStatus;
  sessionDate: string | null;
  rowCount: number | null;
  message: string | null;
  source: string | null;
  warnings: unknown;
  createdAt: Date;
  updatedAt: Date;
}): StockScreenSummary {
  return {
    ...row,
    warnings: (row.warnings as string[] | null) ?? [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The screen's state, without its rows: what polling needs. */
export async function getStockScreen(tx: Transaction, id: string): Promise<StockScreenSummary> {
  const [row] = await tx.select(summaryColumns).from(stockScreens).where(eq(stockScreens.id, id));
  if (!row) throw new IntegrationError('not_found', 'No such screen');
  return toSummary(row);
}

/** The screen with its rows, once ready. */
export async function getStockScreenData(tx: Transaction, id: string): Promise<StockScreenData> {
  const [row] = await tx
    .select({ ...summaryColumns, rows: stockScreens.rows })
    .from(stockScreens)
    .where(eq(stockScreens.id, id));
  if (!row) throw new IntegrationError('not_found', 'No such screen');
  return { ...toSummary(row), rows: (row.rows as ScreenRowTuple[] | null) ?? null };
}

// --- Worker side -------------------------------------------------------------

export async function claimStockScreens(
  db: Database,
  options: { leaseSeconds: number; limit: number },
): Promise<{ screenId: string; userId: string }[]> {
  const rows = await db.execute<{ claimed_id: string; claimed_user: string }>(
    sql`select * from claim_stock_screens(${options.leaseSeconds}, ${options.limit})`,
  );
  return rows.map((r) => ({ screenId: r.claimed_id, userId: r.claimed_user }));
}

export async function loadPendingScreen(tx: Transaction, id: string) {
  const [row] = await tx
    .select({ id: stockScreens.id, attempts: stockScreens.attempts })
    .from(stockScreens)
    .where(and(eq(stockScreens.id, id), eq(stockScreens.status, 'pending')));
  return row;
}

export async function finishStockScreen(
  tx: Transaction,
  id: string,
  outcome:
    | {
        status: 'ready';
        rows: ScreenRowTuple[];
        sessionDate: string | null;
        warnings: string[];
        source: string;
      }
    | { status: 'failed'; message: string; source?: string | undefined }
    | { status: 'retry' },
): Promise<void> {
  // A retry keeps its lease, which then lapses and lets the screen be claimed again.
  if (outcome.status === 'retry') return;
  await tx
    .update(stockScreens)
    .set(
      outcome.status === 'ready'
        ? {
            status: 'ready',
            rows: outcome.rows,
            rowCount: outcome.rows.length,
            sessionDate: outcome.sessionDate,
            warnings: outcome.warnings.map((w) => w.slice(0, 300)).slice(0, 10),
            source: outcome.source.slice(0, 100),
            message: null,
          }
        : {
            status: 'failed',
            message: outcome.message.slice(0, 200),
            source: outcome.source?.slice(0, 100) ?? null,
          },
    )
    .where(and(eq(stockScreens.id, id), eq(stockScreens.status, 'pending')));
}
