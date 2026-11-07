import {
  listOptionUniverse,
  loadOptionSnapshot,
  priorIv30,
  pruneOptionHistory,
  saveOptionSignal,
  saveOptionSnapshot,
  snapshotsAwaitingSignal,
  updateSnapshotCalc,
  updateUniverse,
  type Database,
  type UniverseRow,
} from '@tm/db';
import {
  addDays,
  cboeFileFreshness,
  computeChain,
  computeMetric,
  CboeOptionsFormatError,
  deriveSignals,
  IV_RANK_WINDOW,
  midQuote,
  nextTradingDay,
  nyDate,
  OPTIONS_HISTORY_DAYS_DEFAULT,
  regularSession,
  usableQuote,
  type Bar,
  type MetricReader,
} from '@tm/domain';
import Decimal from 'decimal.js';
import type { Logger } from 'pino';
import type { ChainSource } from './cboe-options';
import { dividendYieldOn, type MarketInputs } from './market-inputs';

/**
 * The daily options recording (options data brief v2 §5.1, ADR 0047). After
 * each NYSE session the worker takes one CBOE snapshot per underlying in the
 * universe, stores the chain, works out IV, delta and gamma with the pricing
 * package and derives that day's signal row and per-expiry rows. Everything
 * is global: one recording serves every tenant.
 */

export const OPTIONS_RECORDING = {
  /** Minutes after the close: the feed is ~15 minutes delayed, so 16:45 reflects ~16:30. */
  afterCloseMinutes: 45,
  /** One retry, half an hour after a failed fetch. */
  retryAfterMinutes: 30,
  maxAttempts: 2,
  /** A snapshot waiting for its close is derived again at most this often. */
  deriveRetryMinutes: 15,
  /** How far back days without a signal are still derived. */
  pendingDays: 10,
} as const;

export interface OptionsJobOptions {
  db: Database;
  chains: ChainSource;
  inputs: MarketInputs;
  logger: Pick<Logger, 'info' | 'warn'>;
  now?: () => Date;
  /** OPTIONS_HISTORY_DAYS (§3.5). */
  historyDays?: number;
  /**
   * Tests only: stands in for the pricing package, so the derive step can be
   * fed the brief's worked chain (fixture F1). Production uses `computeChain`.
   */
  greeks?: typeof computeChain;
  /** Tests only: prior days of IV30 needed for rank and percentile (120). */
  ivRankMinHistory?: number;
}

/**
 * The trading day being recorded at `now`, if any: the latest session whose
 * close was at least 45 minutes ago, until the next session opens. Outside
 * that window the file no longer describes that day's close.
 */
export function recordingDay(now: Date): string | undefined {
  for (let i = 0, d = nyDate(now); i < 10; i++, d = addDays(d, -1)) {
    const session = regularSession(d);
    if (!session) continue;
    const from = Date.parse(session.close) + OPTIONS_RECORDING.afterCloseMinutes * 60_000;
    if (now.getTime() < from) continue;
    const next = regularSession(nextTradingDay(d));
    if (next && now.getTime() >= Date.parse(next.open)) return undefined;
    return d;
  }
  return undefined;
}

/** Whether an underlying is due a fetch for `day` (first try, or the one retry 30 minutes on). */
export function fetchDue(u: UniverseRow, day: string, now: Date): boolean {
  if (u.lastSnapshotDate !== null && u.lastSnapshotDate >= day) return false;
  const tries = u.attemptDate === day ? u.attemptCount : 0;
  if (tries === 0) return true;
  if (tries >= OPTIONS_RECORDING.maxAttempts) return false;
  const last = u.lastAttemptAt?.getTime() ?? 0;
  return now.getTime() - last >= OPTIONS_RECORDING.retryAfterMinutes * 60_000;
}

const shortError = (e: unknown) =>
  (e instanceof Error ? e.message : 'The fetch failed').replace(/\s+/g, ' ').slice(0, 200);

export type RecordOutcome = 'stored' | 'stale' | 'failed';

/** Fetches, validates and stores one underlying's chain for `day`, then derives it. */
export async function recordUnderlying(
  o: OptionsJobOptions,
  u: UniverseRow,
  day: string,
): Promise<RecordOutcome> {
  const now = (o.now ?? (() => new Date()))();
  const tries = (u.attemptDate === day ? u.attemptCount : 0) + 1;
  const fail = async (message: string) => {
    await updateUniverse(o.db, u.underlyingId, {
      lastAttemptAt: now,
      attemptDate: day,
      attemptCount: tries,
      lastError: message,
    });
  };
  let fetched;
  try {
    fetched = await o.chains.chain(u.symbol);
  } catch (e) {
    const message =
      e instanceof CboeOptionsFormatError ? e.message : `CBOE could not be read: ${shortError(e)}`;
    o.logger.warn({ symbol: u.symbol, day, err: { message } }, 'options fetch failed');
    await fail(message);
    return 'failed';
  }
  // The stale-file guard: never store an old file as today's data.
  const fresh = cboeFileFreshness(day, fetched.chain.fileTimestamp);
  if (fresh.stale) {
    const message = `CBOE's ${u.symbol} file is dated ${fetched.chain.fileTimestamp}, before the previous session's close; the last good snapshot stays`;
    o.logger.warn({ symbol: u.symbol, day }, 'stale options file refused');
    await fail(message);
    return 'stale';
  }
  const rows = fetched.chain.rows.map((r) => ({
    ...r,
    ivCalc: null,
    deltaCalc: null,
    gammaCalc: null,
  }));
  await saveOptionSnapshot(o.db, {
    underlyingId: u.underlyingId,
    asOfDate: day,
    underlyingClose: null,
    rows,
    source: 'cboe',
    feed: o.chains.feed,
    fileTimestamp: new Date(fetched.chain.fileTimestamp),
    fetchedAt: now,
    dataVersion: fetched.dataVersion,
  });
  await updateUniverse(o.db, u.underlyingId, {
    lastSnapshotDate: day,
    lastAttemptAt: now,
    attemptDate: day,
    attemptCount: tries,
    lastSkipped: fetched.chain.skipped,
    lastError: fresh.beforeClose
      ? `The ${day} file was stamped ${fetched.chain.fileTimestamp}, before that day's close`
      : null,
  });
  o.logger.info(
    { symbol: u.symbol, day, rows: rows.length, skipped: fetched.chain.skipped },
    'options snapshot stored',
  );
  try {
    if ((await deriveDay(o, u, day)) === 'derived')
      await updateUniverse(o.db, u.underlyingId, { lastSignalDate: day });
  } catch (e) {
    // The snapshot is stored; the day is derived again on a later pass.
    o.logger.warn(
      { symbol: u.symbol, day, err: { message: shortError(e) } },
      'options derive failed',
    );
  }
  return 'stored';
}

export type DeriveOutcome = 'derived' | 'no_snapshot' | 'no_close' | 'no_rate';

const barDate = (b: Bar) => nyDate(b.start);

/** The registry's 20-day realised volatility over a list of daily closes ending on the day. */
export function realizedVol20(closes: readonly number[]): number | null {
  const reader: MetricReader = {
    value: (_expr, barsBack) => {
      const v = closes[closes.length - 1 - barsBack];
      return v === undefined ? undefined : new Decimal(v);
    },
  };
  const v = computeMetric({ metric: 'volatility', params: { window: 20 } }, 'options', reader);
  return v ? v.toNumber() : null;
}

/**
 * Works out a stored day's IV, delta and gamma and its signal rows (§5.1's
 * order of operations). It needs that day's Alpaca close: without it the
 * snapshot stays stored and the signal is computed on a later run, never from
 * a stale close.
 */
export async function deriveDay(
  o: OptionsJobOptions,
  u: Pick<UniverseRow, 'underlyingId' | 'symbol' | 'assetClass'>,
  day: string,
): Promise<DeriveOutcome> {
  const snapshot = await loadOptionSnapshot(o.db, u.underlyingId, day);
  if (!snapshot) return 'no_snapshot';
  const underlying = { id: u.underlyingId, symbol: u.symbol, assetClass: u.assetClass };
  const raw = await o.inputs.dailyBars(underlying, addDays(day, -10), day, 'none');
  const close = raw.find((b) => barDate(b) === day)?.close.toNumber();
  if (close === undefined || !(close > 0)) return 'no_close';
  const r = await o.inputs.riskFreeRate(day);
  if (r === undefined) return 'no_rate';
  const q = await dividendYieldOn(o.db, u, day, close);

  const computed = (o.greeks ?? computeChain)(
    { asOfDate: day, S: close, r, q },
    snapshot.rows.map((x) => ({
      expiry: x.expiry,
      strike: x.strike,
      right: x.right,
      price: usableQuote(x.bid, x.ask) ? midQuote(x.bid, x.ask) : undefined,
    })),
  );
  const calc = new Map<string, { iv: number | null; delta: number | null; gamma: number | null }>();
  snapshot.rows.forEach((x, i) => {
    const c = computed[i];
    calc.set(x.contractId, {
      iv: c?.iv ?? null,
      delta: c?.delta ?? null,
      gamma: c?.gamma ?? null,
    });
  });
  await updateSnapshotCalc(o.db, u.underlyingId, day, close, calc);

  const adjusted = await o.inputs.dailyBars(
    underlying,
    addDays(day, -45),
    day,
    'split_and_dividend',
  );
  const closes = adjusted.filter((b) => barDate(b) <= day).map((b) => b.close.toNumber());
  const prior = await priorIv30(o.db, u.underlyingId, day, addDays(day, -366), IV_RANK_WINDOW);
  const result = deriveSignals({
    asOfDate: day,
    S: close,
    r,
    q,
    rows: snapshot.rows.map((x) => {
      const c = calc.get(x.contractId);
      return {
        expiry: x.expiry,
        strike: x.strike,
        right: x.right,
        bid: x.bid,
        ask: x.ask,
        volume: x.volume,
        openInterest: x.openInterest,
        iv: c?.iv ?? null,
        delta: c?.delta ?? null,
        gamma: c?.gamma ?? null,
      };
    }),
    realizedVol20: realizedVol20(closes),
    priorIv30: prior,
    minHistory: o.ivRankMinHistory,
  });
  await saveOptionSignal(o.db, {
    underlyingId: u.underlyingId,
    asOfDate: day,
    values: result.values,
    ivHistoryDays: result.ivHistoryDays,
    expiries: result.expiries,
    underlyingClose: close,
    riskFreeRate: r,
    dividendYield: q,
    source: 'recorded',
    feed: snapshot.feed,
    computedAt: (o.now ?? (() => new Date()))(),
  });
  if (result.gexSkipped > 0)
    o.logger.info(
      { symbol: u.symbol, day, skipped: result.gexSkipped },
      'rows without gamma or open interest left out of gamma exposure',
    );
  return 'derived';
}

/** Deletes rows older than the history window (§3.5); contracts stay. */
export async function runRetention(o: OptionsJobOptions) {
  const now = (o.now ?? (() => new Date()))();
  const days = o.historyDays ?? OPTIONS_HISTORY_DAYS_DEFAULT;
  const cutoff = addDays(nyDate(now), -days);
  const pruned = await pruneOptionHistory(o.db, cutoff);
  if (pruned.snapshots + pruned.signals + pruned.expiries > 0)
    o.logger.info({ cutoff, ...pruned }, 'old options history deleted');
  return pruned;
}

export interface PassState {
  /** When each waiting day was last derived, so it isn't tried every poll. */
  derivedAt: Map<string, number>;
  retentionDate?: string;
}

/** One pass of the loop: record the day's due underlyings, derive waiting days, prune once a day. */
export async function runOptionsRecording(o: OptionsJobOptions, state: PassState) {
  const now = (o.now ?? (() => new Date()))();
  const day = recordingDay(now);
  const universe = await listOptionUniverse(o.db);
  let recorded = 0;
  if (day) {
    // One underlying at a time (§5.1 pacing).
    for (const u of universe) {
      if (!fetchDue(u, day, now)) continue;
      await recordUnderlying(o, u, day);
      recorded++;
    }
  }
  const byId = new Map(universe.map((u) => [u.underlyingId, u]));
  const waiting = await snapshotsAwaitingSignal(
    o.db,
    addDays(nyDate(now), -OPTIONS_RECORDING.pendingDays),
  );
  for (const w of waiting) {
    const u = byId.get(w.underlyingId);
    const key = `${w.underlyingId}|${w.asOfDate}`;
    const last = state.derivedAt.get(key) ?? 0;
    if (!u || now.getTime() - last < OPTIONS_RECORDING.deriveRetryMinutes * 60_000) continue;
    state.derivedAt.set(key, now.getTime());
    let outcome: DeriveOutcome;
    try {
      outcome = await deriveDay(o, u, w.asOfDate);
    } catch (e) {
      o.logger.warn({ symbol: u.symbol, err: { message: shortError(e) } }, 'options derive failed');
      continue;
    }
    if (outcome === 'derived') {
      state.derivedAt.delete(key);
      await updateUniverse(o.db, u.underlyingId, { lastSignalDate: w.asOfDate });
    }
  }
  const today = nyDate(now);
  if (state.retentionDate !== today) {
    await runRetention(o);
    state.retentionDate = today;
  }
  return { day, recorded, waiting: waiting.length };
}
