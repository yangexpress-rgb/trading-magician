import type { InstrumentRef } from '@tm/backtest';
import {
  BAR_INTERVALS,
  PRICE_ADJUSTMENTS,
  SESSIONS,
  UnsupportedBarRequestError,
  type BarSeries,
  type DealSignal,
  type EarningsSignal,
  type EventData,
  type FundamentalObservation,
  type OptionSignal,
  type RatePoint,
  type ScheduledEarnings,
  type SeriesPoint,
  type ShortInterestPoint,
} from '@tm/domain';
import Decimal from 'decimal.js';
import { and, asc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database, Transaction } from './client';
import { agentConnections, companionFetches } from './schema';

/**
 * What the Local Companion asks the cloud for (ADR 0118, S2 step 3b).
 *
 * The companion writes the ML feature snapshots and labels into its own
 * Research Store with the cloud's code, but the data they read stays in the
 * cloud: a model universe's members and their instruments, daily bars through
 * the person's price feed (or the sharing admin's), point-in-time filings
 * through the company data feed, and earnings from the events store. The web
 * app queues each request as the person; the worker answers it with the same
 * functions the cloud's own snapshot job calls, so a feature computed on the
 * companion equals the cloud's. The companion polls for the answer, which is
 * deleted once read.
 */

export const COMPANION_FETCH_KINDS = [
  'members',
  'bars',
  'filings',
  'events',
  'pattern_members',
  'option_signals',
] as const;
export type CompanionFetchKind = (typeof COMPANION_FETCH_KINDS)[number];

/** Open requests one companion may have at once. */
export const COMPANION_FETCH_OPEN_LIMIT = 4;
/** Items in one request (bar series, companies or instruments). */
export const COMPANION_FETCH_MAX_ITEMS = 200;
/** An answer nobody read, or a request nobody answered, is cleared after this long. */
export const COMPANION_FETCH_KEEP_MS = 3_600_000;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const uuid = z.uuid();

const BarRequestSchema = z.object({
  instrumentId: uuid,
  symbol: z.string().min(1).max(40),
  assetClass: z.string().min(1).max(40),
  interval: z.enum(BAR_INTERVALS),
  from: day,
  to: day,
  adjustment: z.enum(PRICE_ADJUSTMENTS),
  session: z.enum(SESSIONS),
});

export const FETCH_REQUESTS = {
  members: z.object({ universe: z.string().min(1).max(40) }),
  bars: z.object({ requests: z.array(BarRequestSchema).min(1).max(COMPANION_FETCH_MAX_ITEMS) }),
  filings: z.object({
    instruments: z
      .array(z.object({ id: uuid, symbol: z.string().min(1).max(40) }))
      .min(1)
      .max(COMPANION_FETCH_MAX_ITEMS),
  }),
  /** The events metrics read for every id; earnings (all the ML feature set reads) by default. */
  events: z.object({
    ids: z.array(uuid).min(1).max(COMPANION_FETCH_MAX_ITEMS),
    metrics: z
      .array(
        z
          .string()
          .regex(/^[a-z0-9_.]+$/)
          .max(60),
      )
      .min(1)
      .max(40)
      .optional(),
  }),
  /** The factor store's members (ADR 0119): stock groups, former members and the options universe. */
  pattern_members: z.object({}),
  /** Daily options signals from a date on (ADR 0119). */
  option_signals: z.object({
    ids: z.array(uuid).min(1).max(COMPANION_FETCH_MAX_ITEMS),
    from: day,
  }),
} as const;

export type FetchRequest<K extends CompanionFetchKind> = z.infer<(typeof FETCH_REQUESTS)[K]>;

/* ---------- Answers, as JSON ---------- */

/** [start, end, open, high, low, close, volume], prices as decimal strings. */
type BarTuple = [string, string, string, string, string, string, string];

export interface MembersAnswer {
  ids: string[];
  refs: [string, InstrumentRef][];
}

export interface BarsAnswer {
  series: (
    | { bars: BarTuple[]; dataVersion: string; warnings: string[] }
    | { error: string; unsupported: boolean }
  )[];
}

export interface FilingsAnswer {
  byId: [string, FundamentalObservation[]][];
}

export interface EventsAnswer {
  earnings: [string, EarningsSignal[]][];
  calendar: [string, ScheduledEarnings[]][];
  /** Absent in answers from before ADR 0119 (earnings only). */
  deals?: [string, DealSignal[]][];
  rates?: RatePoint[];
  rateSeries?: [string, SeriesPoint[]][] | null;
  shortInterest?: [string, ShortInterestPoint[]][] | null;
  dealsFrom?: string | null;
}

export interface PatternMembersAnswer {
  members: string[];
  sessionMembers: string[];
  refs: [string, InstrumentRef][];
  /** The factor store's first day (PATTERN_SNAPSHOT_FROM in the cloud). */
  from: string;
}

export interface OptionSignalsAnswer {
  byId: [string, OptionSignal[]][];
}

export interface FetchAnswers {
  members: MembersAnswer;
  bars: BarsAnswer;
  filings: FilingsAnswer;
  events: EventsAnswer;
  pattern_members: PatternMembersAnswer;
  option_signals: OptionSignalsAnswer;
}

export function encodeBars(results: readonly (BarSeries | Error)[]): BarsAnswer {
  return {
    series: results.map((r) =>
      r instanceof Error
        ? { error: r.message.slice(0, 300), unsupported: r instanceof UnsupportedBarRequestError }
        : {
            bars: r.bars.map((b): BarTuple => [
              b.start,
              b.end,
              b.open.toString(),
              b.high.toString(),
              b.low.toString(),
              b.close.toString(),
              b.volume.toString(),
            ]),
            dataVersion: r.dataVersion,
            warnings: r.warnings,
          },
    ),
  };
}

export function decodeBars(answer: BarsAnswer): (BarSeries | Error)[] {
  return answer.series.map((s) =>
    'error' in s
      ? s.unsupported
        ? new UnsupportedBarRequestError(s.error)
        : new Error(s.error)
      : {
          bars: s.bars.map(([start, end, open, high, low, close, volume]) => ({
            start,
            end,
            open: new Decimal(open),
            high: new Decimal(high),
            low: new Decimal(low),
            close: new Decimal(close),
            volume: new Decimal(volume),
          })),
          dataVersion: s.dataVersion,
          warnings: s.warnings,
        },
  );
}

const entries = <T>(m: ReadonlyMap<string, readonly T[]>): [string, T[]][] =>
  [...m].map(([id, v]) => [id, [...v]]);

export function encodeEvents(data: EventData): EventsAnswer {
  return {
    earnings: entries(data.earnings),
    calendar: entries(data.calendar),
    deals: entries(data.deals),
    rates: [...data.rates],
    rateSeries: data.rateSeries ? entries(data.rateSeries) : null,
    shortInterest: data.shortInterest ? entries(data.shortInterest) : null,
    dealsFrom: data.dealsFrom ?? null,
  };
}

/** Back to what `loadEventData` returned, including which optional parts it left out. */
export function decodeEvents(answer: EventsAnswer): EventData {
  const out: EventData = {
    earnings: new Map(answer.earnings),
    calendar: new Map(answer.calendar),
    deals: new Map(answer.deals ?? []),
    rates: answer.rates ?? [],
  };
  if (answer.rateSeries) out.rateSeries = new Map(answer.rateSeries);
  if (answer.shortInterest) out.shortInterest = new Map(answer.shortInterest);
  if (answer.dealsFrom !== undefined) out.dealsFrom = answer.dealsFrom ?? undefined;
  return out;
}

/* ---------- The queue ---------- */

export class FetchRefused extends Error {}

/** Queues one request as the person; refused while the companion already has too many open. */
export async function queueCompanionFetch<K extends CompanionFetchKind>(
  tx: Transaction,
  who: { connectionId: string; userId: string },
  kind: K,
  request: FetchRequest<K>,
): Promise<{ id: string }> {
  const [open] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(companionFetches)
    .where(
      and(
        eq(companionFetches.connectionId, who.connectionId),
        isNull(companionFetches.answeredAt),
        isNull(companionFetches.error),
      ),
    );
  if ((open?.n ?? 0) >= COMPANION_FETCH_OPEN_LIMIT) {
    throw new FetchRefused(
      `At most ${COMPANION_FETCH_OPEN_LIMIT} requests may wait at once; read the answers first`,
    );
  }
  const [row] = await tx
    .insert(companionFetches)
    .values({ connectionId: who.connectionId, userId: who.userId, kind, request })
    .returning({ id: companionFetches.id });
  if (!row) throw new Error('companion fetch was not stored');
  return { id: row.id };
}

export type FetchState =
  { status: 'pending' } | { status: 'done'; answer: unknown } | { status: 'failed'; error: string };

/** Reads a request's state as the person; an answer (or a failure) is handed over once and deleted. */
export async function takeCompanionFetch(
  tx: Transaction,
  connectionId: string,
  id: string,
): Promise<FetchState | null> {
  const [row] = await tx
    .select({
      answeredAt: companionFetches.answeredAt,
      answer: companionFetches.answer,
      error: companionFetches.error,
    })
    .from(companionFetches)
    .where(and(eq(companionFetches.id, id), eq(companionFetches.connectionId, connectionId)));
  if (!row) return null;
  if (!row.answeredAt && !row.error) return { status: 'pending' };
  await tx.delete(companionFetches).where(eq(companionFetches.id, id));
  return row.error
    ? { status: 'failed', error: row.error }
    : { status: 'done', answer: row.answer };
}

export type FetchAnswerer = <K extends CompanionFetchKind>(
  kind: K,
  request: FetchRequest<K>,
  userId: string,
) => Promise<FetchAnswers[K]>;

/**
 * The worker's side: takes waiting requests one by one, answers each outside
 * any transaction (bars can take minutes on the feed's background budget) and
 * stores the answer. A request whose pairing has ended is refused; a malformed
 * one fails; any other error is recorded too, and the companion asks again.
 */
export async function answerCompanionFetches(options: {
  core: Database;
  answer: FetchAnswerer;
  limit?: number;
  leaseSeconds?: number;
}): Promise<{ id: string; kind: string; error?: string }[]> {
  const out: { id: string; kind: string; error?: string }[] = [];
  const lease = options.leaseSeconds ?? 600;
  for (let i = 0; i < (options.limit ?? 20); i += 1) {
    const claimed = await options.core.transaction(async (tx) => {
      const [row] = await tx
        .select({
          id: companionFetches.id,
          connectionId: companionFetches.connectionId,
          userId: companionFetches.userId,
          kind: companionFetches.kind,
          request: companionFetches.request,
        })
        .from(companionFetches)
        .where(
          and(
            isNull(companionFetches.answeredAt),
            isNull(companionFetches.error),
            or(
              isNull(companionFetches.claimedUntil),
              lt(companionFetches.claimedUntil, sql`now()`),
            ),
          ),
        )
        .orderBy(asc(companionFetches.requestedAt), asc(companionFetches.id))
        .limit(1)
        .for('update', { skipLocked: true });
      if (!row) return null;
      await tx
        .update(companionFetches)
        .set({ claimedUntil: sql`now() + make_interval(secs => ${lease})` })
        .where(eq(companionFetches.id, row.id));
      // The pairing is read as its owner (row-level security).
      await tx.execute(sql`select set_config('app.user_id', ${row.userId}, true)`);
      const [conn] = await tx
        .select({ scope: agentConnections.scope, revokedAt: agentConnections.revokedAt })
        .from(agentConnections)
        .where(eq(agentConnections.id, row.connectionId));
      await tx.execute(sql`select set_config('app.user_id', '', true)`);
      return { ...row, paired: !!conn && conn.scope === 'research_sync' && !conn.revokedAt };
    });
    if (!claimed) break;
    let answer: unknown = null;
    let error: string | null = null;
    if (!claimed.paired) {
      error = 'The companion was unpaired before this request was answered';
    } else {
      const kind = claimed.kind as CompanionFetchKind;
      const parsed = FETCH_REQUESTS[kind]?.safeParse(claimed.request);
      if (!parsed?.success) {
        error = 'The request is malformed';
      } else {
        try {
          answer = await options.answer(kind, parsed.data as never, claimed.userId);
        } catch (e) {
          error = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, 300);
        }
      }
    }
    await options.core
      .update(companionFetches)
      .set(error ? { error, claimedUntil: null } : { answeredAt: sql`now()`, answer })
      .where(eq(companionFetches.id, claimed.id));
    out.push({ id: claimed.id, kind: claimed.kind, ...(error ? { error } : {}) });
  }
  return out;
}

/** Clears answers nobody read and requests nobody answered, after an hour. */
export async function clearStaleCompanionFetches(core: Database): Promise<number> {
  const gone = await core
    .delete(companionFetches)
    .where(
      lt(
        companionFetches.requestedAt,
        sql`now() - make_interval(secs => ${COMPANION_FETCH_KEEP_MS / 1000})`,
      ),
    )
    .returning({ id: companionFetches.id });
  return gone.length;
}
