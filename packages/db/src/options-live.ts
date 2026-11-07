import {
  LIVE_CHAIN_CACHE_MINUTES,
  type LiveChainView,
  type OptionSignalSource,
  type OptionSignalValues,
} from '@tm/domain';
import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { Database, Transaction } from './client';
import { IntegrationError } from './feeds';
import { activeOptionsFeed, signalRowValues } from './options';
import { instruments, optionDailySignals, optionLiveChains, optionUniverse } from './schema';

/**
 * Research › Options (options data brief v2 §7, §10 item 8, ADR 0048). The
 * live chain is asked for by the app and answered by the worker, then kept
 * for 15 minutes per symbol for everyone. The daily history comes from the
 * recording (ADR 0047).
 */

type Db = Database | Transaction;

const SYMBOL = /^[A-Z][A-Z0-9.]{0,9}$/;

export type LiveChainStatus = 'pending' | 'ready' | 'failed';

export interface LiveChainSummary {
  symbol: string;
  status: LiveChainStatus;
  message: string | null;
  /** The stored view; kept while a refresh is pending. */
  view: LiveChainView | null;
  requestedAt: string;
  finishedAt: string | null;
  /** When the cached view stops being reused. */
  freshUntil: string | null;
}

export function normaliseOptionSymbol(raw: string): string {
  const symbol = raw.trim().toUpperCase().replace(/-/g, '.');
  if (!SYMBOL.test(symbol)) throw new IntegrationError('bad_request', 'That is not a US ticker');
  return symbol;
}

const OPTIONS_FEED_NEEDED =
  'Add the "CBOE delayed options (daily)" feed under Settings › Data feeds to see options data.';

/** Asks for a symbol's live chain unless a fresh or pending one exists (15-minute cache). */
export async function requestLiveChain(tx: Transaction, raw: string): Promise<LiveChainSummary> {
  const symbol = normaliseOptionSymbol(raw);
  if (!(await activeOptionsFeed(tx)))
    throw new IntegrationError('invalid_state', OPTIONS_FEED_NEEDED);
  try {
    await tx.execute(sql`select request_option_chain(${symbol})`);
  } catch (e) {
    const code =
      (e as { code?: string; cause?: { code?: string } }).code ??
      (e as { cause?: { code?: string } }).cause?.code;
    if (code === '54000')
      throw new IntegrationError('conflict', 'Many option chains are loading; try again shortly');
    throw e;
  }
  return (await getLiveChain(tx, symbol)) as LiveChainSummary;
}

export async function getLiveChain(db: Db, raw: string): Promise<LiveChainSummary | undefined> {
  const symbol = normaliseOptionSymbol(raw);
  const [row] = await db.select().from(optionLiveChains).where(eq(optionLiveChains.symbol, symbol));
  if (!row) return undefined;
  const fresh =
    row.status !== 'failed' && row.finishedAt && row.view
      ? new Date(row.finishedAt.getTime() + LIVE_CHAIN_CACHE_MINUTES * 60_000).toISOString()
      : null;
  return {
    symbol: row.symbol,
    status: row.status as LiveChainStatus,
    message: row.message,
    view: (row.view as LiveChainView | null) ?? null,
    requestedAt: row.requestedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    freshUntil: fresh,
  };
}

/** One recorded day of an underlying, for the IV history chart and the screener. */
export interface DailyOptionPoint {
  date: string;
  iv30: number | null;
  source: OptionSignalSource;
}

export interface OptionsHistory {
  underlyingId: string;
  /** Whether the symbol is in the recorded universe. */
  recorded: boolean;
  points: DailyOptionPoint[];
  /** The latest day's full signal row, for when the live chain can't be had. */
  latest: { date: string; values: OptionSignalValues; source: OptionSignalSource } | null;
}

const toNum = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** The recorded daily IV30 of a symbol since a date, plus its latest signal row. */
export async function optionsHistory(
  db: Db,
  raw: string,
  sinceDate: string,
): Promise<OptionsHistory | undefined> {
  const symbol = normaliseOptionSymbol(raw);
  const [u] = await db
    .select({ id: optionUniverse.underlyingId })
    .from(optionUniverse)
    .innerJoin(instruments, eq(instruments.id, optionUniverse.underlyingId))
    .where(eq(instruments.symbol, symbol))
    .limit(1);
  if (!u) return undefined;
  const rows = await db
    .select()
    .from(optionDailySignals)
    .where(
      and(eq(optionDailySignals.underlyingId, u.id), gte(optionDailySignals.asOfDate, sinceDate)),
    )
    .orderBy(asc(optionDailySignals.asOfDate));
  const last = rows.at(-1);
  return {
    underlyingId: u.id,
    recorded: true,
    points: rows.map((r) => ({
      date: r.asOfDate,
      iv30: toNum(r.iv30),
      source: r.source as OptionSignalSource,
    })),
    latest: last
      ? {
          date: last.asOfDate,
          source: last.source as OptionSignalSource,
          values: signalRowValues(last),
        }
      : null,
  };
}

/**
 * The latest signal of each instrument on or after `sinceDate` (the screener's
 * options columns read the daily recording, brief §10 item 9).
 */
export async function latestOptionSignals(
  db: Db,
  instrumentIds: readonly string[],
  sinceDate: string,
): Promise<Map<string, { date: string; values: OptionSignalValues; source: OptionSignalSource }>> {
  const out = new Map<
    string,
    { date: string; values: OptionSignalValues; source: OptionSignalSource }
  >();
  if (instrumentIds.length === 0) return out;
  const rows = await db
    .selectDistinctOn([optionDailySignals.underlyingId])
    .from(optionDailySignals)
    .where(
      and(
        inArray(optionDailySignals.underlyingId, [...instrumentIds]),
        gte(optionDailySignals.asOfDate, sinceDate),
      ),
    )
    .orderBy(optionDailySignals.underlyingId, desc(optionDailySignals.asOfDate));
  for (const r of rows)
    out.set(r.underlyingId, {
      date: r.asOfDate,
      source: r.source as OptionSignalSource,
      values: signalRowValues(r),
    });
  return out;
}

// --- Worker side -------------------------------------------------------------

/** Claims waiting chains for the worker, oldest request first. */
export async function claimLiveChains(
  db: Database,
  options: { leaseSeconds: number; limit: number },
): Promise<{ symbol: string; attempts: number }[]> {
  const rows = await db.execute<{ symbol: string; attempts: number }>(sql`
    update option_live_chain c
       set lease_expires_at = now() + make_interval(secs => ${options.leaseSeconds}),
           attempts = c.attempts + 1
     where c.symbol in (
       select symbol from option_live_chain
        where status = 'pending' and (lease_expires_at is null or lease_expires_at < now())
        order by requested_at
        limit ${options.limit}
        for update skip locked)
    returning c.symbol, c.attempts`);
  return rows.map((r) => ({ symbol: r.symbol, attempts: Number(r.attempts) }));
}

export async function finishLiveChain(
  db: Database,
  symbol: string,
  outcome:
    | { status: 'ready'; view: LiveChainView }
    | { status: 'failed'; message: string }
    | { status: 'retry' },
  now: Date = new Date(),
): Promise<void> {
  // A retry keeps its lease, which then lapses and lets the chain be claimed again.
  if (outcome.status === 'retry') return;
  await db
    .update(optionLiveChains)
    .set(
      outcome.status === 'ready'
        ? {
            status: 'ready',
            view: outcome.view,
            chainTime: new Date(outcome.view.chainTime),
            message: null,
            finishedAt: now,
            leaseExpiresAt: null,
          }
        : {
            status: 'failed',
            message: outcome.message.slice(0, 200),
            finishedAt: now,
            leaseExpiresAt: null,
          },
    )
    .where(and(eq(optionLiveChains.symbol, symbol), eq(optionLiveChains.status, 'pending')));
}

/** Deletes chains nobody has asked for in a day. */
export async function pruneLiveChains(db: Database): Promise<number> {
  const rows = await db
    .delete(optionLiveChains)
    .where(sql`${optionLiveChains.requestedAt} < now() - interval '1 day'`)
    .returning({ symbol: optionLiveChains.symbol });
  return rows.length;
}
