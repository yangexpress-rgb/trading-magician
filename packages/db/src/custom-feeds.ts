import { createHash } from 'node:crypto';
import {
  canonicalCustomRestConfig,
  checkCustomRestConfig,
  providerNeedsKey,
  type CustomDailyBar,
  type CustomQuote,
  type CustomRestConfig,
  type CustomRestConfigInput,
} from '@tm/domain';
import { and, desc, eq, gte, lt, lte, sql } from 'drizzle-orm';
import type { Database, Transaction } from './client';
import { IntegrationError } from './feeds';
import { credentials, customFeedCache, customFeedTests, customFeedUsage } from './schema';

/**
 * Custom REST feeds (v1.2 N17; ADR 0041): the test a description must pass
 * before it is saved, the database cache of what feeds answered, and the
 * request counters that keep each feed under its limits across workers.
 */

/** A test is good for saving this long after it succeeded. */
export const CUSTOM_TEST_VALID_MS = 60 * 60 * 1000;

export interface CustomFeedTestResult {
  symbol: string;
  bars: {
    count: number;
    first: string | null;
    last: string | null;
    /** The latest few, newest last. */
    sample: CustomDailyBar[];
    /** The request, with the key masked. */
    url: string;
  };
  quote: CustomQuote & { url: string };
}

export interface CustomFeedTestSummary {
  id: string;
  status: 'pending' | 'succeeded' | 'failed';
  symbol: string;
  result: CustomFeedTestResult | null;
  message: string | null;
  createdAt: string;
}

/** Ties a test to exactly one description and one key. */
export function customFeedDigest(config: CustomRestConfig, credentialRef: string | null): string {
  return createHash('sha256')
    .update(`${canonicalCustomRestConfig(config)}\n${credentialRef ?? ''}`)
    .digest('hex');
}

/**
 * Checks a description from the form; problems name their fields, so the
 * form can show each one beside its input.
 */
export function checkedCustomConfig(input: unknown): CustomRestConfig {
  const checked = checkCustomRestConfig(input as CustomRestConfigInput);
  if (!checked.ok) {
    const first = checked.problems[0];
    throw new IntegrationError('bad_request', first?.message ?? 'Check the feed settings', {
      problems: checked.problems,
    });
  }
  return checked.config;
}

/** The key a custom feed signs in with: none, or one of the person's custom REST keys. */
export async function customCredential(
  tx: Transaction,
  config: CustomRestConfig,
  credentialId: string | null | undefined,
): Promise<string | null> {
  if (!providerNeedsKey('custom_rest', config.auth.type)) {
    if (credentialId) {
      throw new IntegrationError('bad_request', 'This feed signs in with no key; remove the key');
    }
    return null;
  }
  if (!credentialId) {
    throw new IntegrationError(
      'bad_request',
      'Enter or choose the API key this feed signs in with',
    );
  }
  const [cred] = await tx
    .select({ id: credentials.id, provider: credentials.provider })
    .from(credentials)
    .where(eq(credentials.id, credentialId));
  if (!cred) throw new IntegrationError('bad_request', 'That API key no longer exists');
  if (cred.provider !== 'custom_rest') {
    throw new IntegrationError('bad_request', 'That key is not a custom REST key');
  }
  return cred.id;
}

const toSummary = (r: typeof customFeedTests.$inferSelect): CustomFeedTestSummary => ({
  id: r.id,
  status: r.status,
  symbol: r.symbol,
  result: (r.result as CustomFeedTestResult | null) ?? null,
  message: r.message,
  createdAt: r.createdAt.toISOString(),
});

/** Asks the worker to test a description with one symbol, before it is saved. */
export async function requestCustomFeedTest(
  tx: Transaction,
  input: {
    userId: string;
    config: unknown;
    credentialId?: string | null | undefined;
    symbol?: string | undefined;
  },
): Promise<CustomFeedTestSummary> {
  const config = checkedCustomConfig(input.config);
  const credentialRef = await customCredential(tx, config, input.credentialId);
  const symbol = (input.symbol?.trim() || config.testSymbol).toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]{0,11}$/.test(symbol)) {
    throw new IntegrationError('bad_request', 'Enter a ticker symbol to test with, such as SPY');
  }
  const [row] = await tx
    .insert(customFeedTests)
    .values({
      userId: input.userId,
      config,
      digest: customFeedDigest(config, credentialRef),
      credentialRef,
      symbol,
    })
    .returning();
  if (!row) throw new Error('test insert failed');
  return toSummary(row);
}

export async function getCustomFeedTest(
  tx: Transaction,
  id: string,
): Promise<CustomFeedTestSummary> {
  const [row] = await tx.select().from(customFeedTests).where(eq(customFeedTests.id, id));
  if (!row) throw new IntegrationError('not_found', 'Test not found');
  return toSummary(row);
}

/**
 * Refuses to save a description that has not passed a test: the test must
 * have succeeded within the hour, for this exact description and key.
 */
export async function assertCustomFeedTested(
  tx: Transaction,
  input: {
    config: CustomRestConfig;
    credentialRef: string | null;
    testId: string | null | undefined;
    now?: Date;
  },
): Promise<void> {
  const refuse = (why: string) => {
    throw new IntegrationError('bad_request', why);
  };
  if (!input.testId) return refuse('Test the feed before saving it');
  const [row] = await tx.select().from(customFeedTests).where(eq(customFeedTests.id, input.testId));
  if (!row) return refuse('Test the feed before saving it');
  if (row.status !== 'succeeded')
    return refuse('The last test did not succeed; fix it and test again');
  if (row.digest !== customFeedDigest(input.config, input.credentialRef)) {
    return refuse('The settings changed since the last test; test again before saving');
  }
  const now = input.now ?? new Date();
  if (now.getTime() - row.updatedAt.getTime() > CUSTOM_TEST_VALID_MS) {
    return refuse('The last test is more than an hour old; test again before saving');
  }
}

// ---------------------------------------------------------------------------
// Worker: tests
// ---------------------------------------------------------------------------

export async function claimCustomFeedTests(
  db: Database,
  options: { leaseSeconds: number; limit: number },
): Promise<{ testId: string; userId: string }[]> {
  const rows = await db.execute<{ claimed_id: string; claimed_user: string }>(
    sql`select * from claim_custom_feed_tests(${options.leaseSeconds}, ${options.limit})`,
  );
  return rows.map((r) => ({ testId: r.claimed_id, userId: r.claimed_user }));
}

export interface CustomFeedTestToRun {
  id: string;
  config: CustomRestConfig;
  credentialRef: string | null;
  symbol: string;
}

export async function loadCustomFeedTest(
  tx: Transaction,
  id: string,
): Promise<CustomFeedTestToRun | undefined> {
  const [row] = await tx.select().from(customFeedTests).where(eq(customFeedTests.id, id));
  if (!row || row.status !== 'pending') return undefined;
  return {
    id: row.id,
    config: row.config as CustomRestConfig,
    credentialRef: row.credentialRef,
    symbol: row.symbol,
  };
}

export async function finishCustomFeedTest(
  tx: Transaction,
  input: { id: string } & (
    { ok: true; result: CustomFeedTestResult } | { ok: false; message: string }
  ),
): Promise<void> {
  await tx
    .update(customFeedTests)
    .set(
      input.ok
        ? { status: 'succeeded', result: input.result, message: null, leaseExpiresAt: null }
        : { status: 'failed', message: input.message.slice(0, 600), leaseExpiresAt: null },
    )
    .where(eq(customFeedTests.id, input.id));
}

// ---------------------------------------------------------------------------
// Worker: cache
// ---------------------------------------------------------------------------

/** Daily bars for a range that has finished are kept 12 hours; one that reaches today, 15 minutes. */
export const CUSTOM_CACHE = {
  closedBarsMs: 12 * 60 * 60 * 1000,
  openBarsMs: 15 * 60 * 1000,
  quoteMs: 15 * 1000,
  /** Rows older than this are deleted when a feed writes. */
  pruneMs: 3 * 24 * 60 * 60 * 1000,
} as const;

/** Cached bars that cover the range, fetched after `freshSince`; the newest wins. */
export async function readCachedBars(
  tx: Transaction,
  input: { feedId: string; symbol: string; from: string; to: string; freshSince: Date },
): Promise<{ bars: CustomDailyBar[]; fetchedAt: Date } | undefined> {
  const [row] = await tx
    .select({ payload: customFeedCache.payload, fetchedAt: customFeedCache.fetchedAt })
    .from(customFeedCache)
    .where(
      and(
        eq(customFeedCache.feedId, input.feedId),
        eq(customFeedCache.kind, 'bars'),
        eq(customFeedCache.symbol, input.symbol),
        lte(customFeedCache.rangeFrom, input.from),
        gte(customFeedCache.rangeTo, input.to),
        gte(customFeedCache.fetchedAt, input.freshSince),
      ),
    )
    .orderBy(desc(customFeedCache.fetchedAt))
    .limit(1);
  return row ? { bars: row.payload as CustomDailyBar[], fetchedAt: row.fetchedAt } : undefined;
}

export async function readCachedQuote(
  tx: Transaction,
  input: { feedId: string; symbol: string; freshSince: Date },
): Promise<{ quote: CustomQuote; fetchedAt: Date } | undefined> {
  const [row] = await tx
    .select({ payload: customFeedCache.payload, fetchedAt: customFeedCache.fetchedAt })
    .from(customFeedCache)
    .where(
      and(
        eq(customFeedCache.feedId, input.feedId),
        eq(customFeedCache.kind, 'quote'),
        eq(customFeedCache.symbol, input.symbol),
        gte(customFeedCache.fetchedAt, input.freshSince),
      ),
    )
    .limit(1);
  return row ? { quote: row.payload as CustomQuote, fetchedAt: row.fetchedAt } : undefined;
}

export async function writeCache(
  tx: Transaction,
  input: {
    userId: string;
    feedId: string;
    kind: 'bars' | 'quote';
    symbol: string;
    from?: string;
    to?: string;
    payload: CustomDailyBar[] | CustomQuote;
    now: Date;
  },
): Promise<void> {
  const values = {
    userId: input.userId,
    feedId: input.feedId,
    kind: input.kind,
    symbol: input.symbol,
    rangeFrom: input.from ?? '',
    rangeTo: input.to ?? '',
    payload: input.payload,
    fetchedAt: input.now,
  };
  await tx
    .insert(customFeedCache)
    .values(values)
    .onConflictDoUpdate({
      target: [
        customFeedCache.feedId,
        customFeedCache.kind,
        customFeedCache.symbol,
        customFeedCache.rangeFrom,
        customFeedCache.rangeTo,
      ],
      set: { payload: values.payload, fetchedAt: values.fetchedAt },
    });
  await tx
    .delete(customFeedCache)
    .where(
      and(
        eq(customFeedCache.feedId, input.feedId),
        lt(customFeedCache.fetchedAt, new Date(input.now.getTime() - CUSTOM_CACHE.pruneMs)),
      ),
    );
}

// ---------------------------------------------------------------------------
// Worker: request limits
// ---------------------------------------------------------------------------

export type TakeResult = { ok: true } | { ok: false; reason: string };

const minuteStart = (now: Date) => new Date(Math.floor(now.getTime() / 60_000) * 60_000);
/** Days are counted in UTC, as most providers reset their daily quota. */
const dayStart = (now: Date) => new Date(`${now.toISOString().slice(0, 10)}T00:00:00Z`);

async function bump(
  tx: Transaction,
  input: { userId: string; feedId: string; period: 'minute' | 'day'; windowStart: Date },
): Promise<number> {
  const [row] = await tx
    .insert(customFeedUsage)
    .values({ ...input, count: 1 })
    .onConflictDoUpdate({
      target: [customFeedUsage.feedId, customFeedUsage.period, customFeedUsage.windowStart],
      set: { count: sql`${customFeedUsage.count} + 1` },
    })
    .returning({ count: customFeedUsage.count });
  return row?.count ?? 1;
}

/**
 * Counts one request against a feed's limits and says whether it may go.
 * A refused request is not counted. Counts live in the database, so every
 * worker shares them.
 */
export async function takeCustomFeedRequest(
  tx: Transaction,
  input: { userId: string; feedId: string; now: Date; limits: CustomRestConfig['limits'] },
): Promise<TakeResult> {
  const { limits, now } = input;
  const minute = await bump(tx, { ...input, period: 'minute', windowStart: minuteStart(now) });
  const day =
    limits.requestsPerDay === null
      ? 0
      : await bump(tx, { ...input, period: 'day', windowStart: dayStart(now) });
  const over =
    minute > limits.requestsPerMinute
      ? `its limit of ${limits.requestsPerMinute} requests a minute is used up`
      : limits.requestsPerDay !== null && day > limits.requestsPerDay
        ? `its daily limit of ${limits.requestsPerDay.toLocaleString('en-US')} requests is used up`
        : null;
  if (over) {
    // Give the refused request back, so the counts are what was really sent.
    await tx
      .update(customFeedUsage)
      .set({ count: sql`${customFeedUsage.count} - 1` })
      .where(
        and(
          eq(customFeedUsage.feedId, input.feedId),
          sql`((${customFeedUsage.period} = 'minute' and ${customFeedUsage.windowStart} = ${minuteStart(now).toISOString()}::timestamptz)
              or (${customFeedUsage.period} = 'day' and ${customFeedUsage.windowStart} = ${dayStart(now).toISOString()}::timestamptz))`,
        ),
      );
    return { ok: false, reason: `Held back: ${over}` };
  }
  // Old windows are not needed once a new one starts.
  await tx.delete(customFeedUsage).where(
    and(
      eq(customFeedUsage.feedId, input.feedId),
      sql`((${customFeedUsage.period} = 'minute' and ${customFeedUsage.windowStart} < ${minuteStart(now).toISOString()}::timestamptz)
              or (${customFeedUsage.period} = 'day' and ${customFeedUsage.windowStart} < ${dayStart(now).toISOString()}::timestamptz))`,
    ),
  );
  return { ok: true };
}
