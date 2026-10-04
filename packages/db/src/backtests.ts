import {
  seriesExprs,
  type BacktestInputs,
  type BacktestMetrics,
  type BacktestResult,
  type InstrumentRef,
} from '@tm/backtest';
import { parseDefinition, validateStrategy, type StrategyDefinition } from '@tm/domain';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { recordAudit } from './audit';
import type { Database, Transaction } from './client';
import {
  backtestRuns,
  backtestTrades,
  entitlements,
  instruments,
  strategyVersions,
} from './schema';
import { loadValidationContext, pinDraftVersion, StrategyError } from './strategies';

/**
 * Back-test runs (Design v1.0 §7, §13.3, §14.2; ADR 0009).
 *
 * The web app queues a run inside the user's tenant. A worker claims the oldest
 * runnable run with `claimBacktestRun` (a SECURITY DEFINER function using
 * `FOR UPDATE SKIP LOCKED`), which hands back only the run and tenant ids. Every
 * other read and write happens inside `withTenant`, guarded by the lease owner,
 * so a worker that lost its lease can't overwrite the run.
 */

export type BacktestRunStatus = (typeof backtestRuns.$inferSelect)['status'];

/** The only data source until a real provider is chosen (§20 #1). */
export const BACKTEST_DATA_SOURCE = 'demo-history';
export const DEFAULT_CONCURRENT_BACKTESTS = 2;
export const DEFAULT_BACKTESTS_PER_DAY = 100;

export interface BacktestRunSummary {
  id: string;
  strategyId: string;
  versionId: string;
  versionNo: number;
  definitionHash: string;
  status: BacktestRunStatus;
  inputs: BacktestInputs;
  dataSource: string;
  engineVersion: string | null;
  dataVersions: string[];
  metrics: BacktestMetrics | null;
  error: string | null;
  cancelRequested: boolean;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

/** What the results view needs besides the trade list. */
export type BacktestRunResult = Omit<BacktestResult, 'trades' | 'metrics'>;

export interface BacktestRunDetail extends BacktestRunSummary {
  result: BacktestRunResult | null;
}

export interface BacktestTradeRow {
  cycle: number;
  status: 'closed' | 'open' | 'aborted';
  entryTime: Date | null;
  exitTime: Date | null;
  grossPnl: string;
  costs: string;
  netPnl: string;
  returnPct: string | null;
  legs: BacktestResult['trades'][number]['legs'];
}

const summaryColumns = {
  id: backtestRuns.id,
  strategyId: backtestRuns.strategyId,
  versionId: backtestRuns.versionId,
  versionNo: strategyVersions.versionNo,
  definitionHash: backtestRuns.definitionHash,
  status: backtestRuns.status,
  inputs: backtestRuns.inputs,
  dataSource: backtestRuns.dataSource,
  engineVersion: backtestRuns.engineVersion,
  dataVersions: backtestRuns.dataVersions,
  metrics: backtestRuns.summary,
  error: backtestRuns.error,
  cancelRequested: backtestRuns.cancelRequested,
  createdAt: backtestRuns.createdAt,
  startedAt: backtestRuns.startedAt,
  finishedAt: backtestRuns.finishedAt,
};

type SummaryRow = Omit<BacktestRunSummary, 'inputs' | 'metrics'> & {
  inputs: unknown;
  metrics: unknown;
};

const toSummary = (r: SummaryRow): BacktestRunSummary => ({
  ...r,
  inputs: r.inputs as BacktestInputs,
  metrics: r.metrics as BacktestMetrics | null,
});

function selectRuns(tx: Transaction) {
  return tx
    .select(summaryColumns)
    .from(backtestRuns)
    .innerJoin(strategyVersions, eq(strategyVersions.id, backtestRuns.versionId));
}

// ---------------------------------------------------------------------------
// Requests from the app

/**
 * Queues a back test of the strategy's current draft, pinned to an immutable
 * version. Blocked while validation has errors, and by the plan's limits on
 * concurrent and daily runs.
 */
export async function startBacktest(
  tx: Transaction,
  userId: string,
  strategyId: string,
  inputs: BacktestInputs,
): Promise<BacktestRunDetail> {
  // One request at a time per user, so the limits below can't be raced.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('backtest:' || ${userId}))`);

  const pinned = await pinDraftVersion(tx, userId, strategyId);
  if (pinned.row.archivedAt) {
    throw new StrategyError('invalid_state', 'Restore this strategy before back testing it');
  }
  const validation = validateStrategy(pinned.definition, await loadValidationContext(tx));
  if (validation.errors.length > 0) {
    throw new StrategyError(
      'transition_blocked',
      'Fix the problems listed under Validation before running a back test',
      { reason: 'validation_errors', details: [], validation },
    );
  }

  const [entitlement] = await tx.select({ limits: entitlements.limits }).from(entitlements);
  const limits = (entitlement?.limits ?? {}) as Record<string, unknown>;
  const concurrent = numberOr(limits.concurrentBacktests, DEFAULT_CONCURRENT_BACKTESTS);
  const perDay = numberOr(limits.backtestRunsPerDay, DEFAULT_BACKTESTS_PER_DAY);
  const [counts] = await tx
    .select({
      active: sql<number>`count(*) filter (where ${backtestRuns.status} in ('queued', 'running'))::int`,
      today: sql<number>`count(*) filter (where ${backtestRuns.createdAt} > now() - interval '1 day')::int`,
    })
    .from(backtestRuns);
  if ((counts?.active ?? 0) >= concurrent) {
    throw new StrategyError(
      'limit_reached',
      `You can run ${concurrent} back tests at a time. Wait for one to finish or cancel it.`,
    );
  }
  if ((counts?.today ?? 0) >= perDay) {
    throw new StrategyError(
      'limit_reached',
      `Your plan allows ${perDay} back tests a day. Try again tomorrow.`,
    );
  }

  const [run] = await tx
    .insert(backtestRuns)
    .values({
      userId,
      strategyId,
      versionId: pinned.versionId,
      definitionHash: pinned.row.draftHash,
      inputs,
      dataSource: BACKTEST_DATA_SOURCE,
      createdBy: userId,
    })
    .returning({ id: backtestRuns.id });
  if (!run) throw new Error('Failed to queue back test');
  await recordAudit(tx, {
    userId,
    actorType: 'user',
    action: 'backtest.requested',
    resourceType: 'backtest_run',
    resourceId: run.id,
    afterRef: pinned.row.draftHash,
    context: { strategyId, versionId: pinned.versionId, versionNo: pinned.versionNo },
  });
  return getBacktest(tx, run.id);
}

const numberOr = (v: unknown, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;

export async function getBacktest(tx: Transaction, runId: string): Promise<BacktestRunDetail> {
  const [row] = await tx
    .select({ ...summaryColumns, result: backtestRuns.result })
    .from(backtestRuns)
    .innerJoin(strategyVersions, eq(strategyVersions.id, backtestRuns.versionId))
    .where(eq(backtestRuns.id, runId));
  if (!row) throw new StrategyError('not_found', 'Back test not found');
  const { result, ...summary } = row;
  return { ...toSummary(summary), result: (result ?? null) as BacktestRunResult | null };
}

/** A strategy's runs, newest first. */
export async function listBacktests(
  tx: Transaction,
  strategyId: string,
  limit = 20,
): Promise<BacktestRunSummary[]> {
  const rows = await selectRuns(tx)
    .where(eq(backtestRuns.strategyId, strategyId))
    .orderBy(desc(backtestRuns.createdAt))
    .limit(limit);
  return rows.map(toSummary);
}

/** The latest completed run, for the activation gate (§7.4). */
export async function latestCompletedBacktest(
  tx: Transaction,
  strategyId: string,
): Promise<BacktestRunSummary | null> {
  const [row] = await selectRuns(tx)
    .where(and(eq(backtestRuns.strategyId, strategyId), eq(backtestRuns.status, 'completed')))
    .orderBy(desc(backtestRuns.finishedAt))
    .limit(1);
  return row ? toSummary(row) : null;
}

export async function listBacktestTrades(
  tx: Transaction,
  runId: string,
): Promise<BacktestTradeRow[]> {
  await getRunStatus(tx, runId);
  const rows = await tx
    .select({
      cycle: backtestTrades.cycle,
      status: backtestTrades.status,
      entryTime: backtestTrades.entryTime,
      exitTime: backtestTrades.exitTime,
      grossPnl: backtestTrades.grossPnl,
      costs: backtestTrades.costs,
      netPnl: backtestTrades.netPnl,
      returnPct: backtestTrades.returnPct,
      legs: backtestTrades.legs,
    })
    .from(backtestTrades)
    .where(eq(backtestTrades.runId, runId))
    .orderBy(backtestTrades.cycle);
  return rows as BacktestTradeRow[];
}

async function getRunStatus(tx: Transaction, runId: string) {
  const [row] = await tx
    .select({ status: backtestRuns.status, strategyId: backtestRuns.strategyId })
    .from(backtestRuns)
    .where(eq(backtestRuns.id, runId));
  if (!row) throw new StrategyError('not_found', 'Back test not found');
  return row;
}

/**
 * Cancels a run. A queued run ends at once; a running one is flagged and the
 * worker stops at its next checkpoint (or the queue ends it once its lease lapses).
 */
export async function cancelBacktest(
  tx: Transaction,
  userId: string,
  runId: string,
): Promise<BacktestRunDetail> {
  const { status } = await getRunStatus(tx, runId);
  if (status === 'queued') {
    await tx
      .update(backtestRuns)
      .set({ status: 'canceled', cancelRequested: true, finishedAt: sql`now()` })
      .where(and(eq(backtestRuns.id, runId), eq(backtestRuns.status, 'queued')));
  } else if (status === 'running') {
    await tx
      .update(backtestRuns)
      .set({ cancelRequested: true })
      .where(and(eq(backtestRuns.id, runId), eq(backtestRuns.status, 'running')));
  } else {
    throw new StrategyError('invalid_state', 'This back test has already finished');
  }
  await recordAudit(tx, {
    userId,
    actorType: 'user',
    action: 'backtest.cancel_requested',
    resourceType: 'backtest_run',
    resourceId: runId,
    context: { status },
  });
  return getBacktest(tx, runId);
}

// ---------------------------------------------------------------------------
// The worker's side

export interface ClaimedRun {
  runId: string;
  userId: string;
}

/** Claims the oldest runnable run across tenants, or returns null when there is none. */
export async function claimBacktestRun(
  db: Database,
  worker: string,
  options: { leaseSeconds: number; maxAttempts: number },
): Promise<ClaimedRun | null> {
  const rows = await db.execute<{ claimed_id: string; claimed_user: string }>(
    sql`select * from claim_backtest_run(${worker}, ${options.leaseSeconds}, ${options.maxAttempts})`,
  );
  const row = rows[0];
  return row ? { runId: row.claimed_id, userId: row.claimed_user } : null;
}

const ownedBy = (runId: string, worker: string) =>
  and(
    eq(backtestRuns.id, runId),
    eq(backtestRuns.leaseOwner, worker),
    eq(backtestRuns.status, 'running'),
  );

export interface RunWork {
  inputs: BacktestInputs;
  definition: StrategyDefinition;
  instruments: Map<string, InstrumentRef>;
  cancelRequested: boolean;
}

/** Everything a claimed run needs, or null if this worker no longer holds it. */
export async function loadRunWork(
  tx: Transaction,
  runId: string,
  worker: string,
): Promise<RunWork | null> {
  const [row] = await tx
    .select({
      inputs: backtestRuns.inputs,
      definition: strategyVersions.definition,
      cancelRequested: backtestRuns.cancelRequested,
    })
    .from(backtestRuns)
    .innerJoin(strategyVersions, eq(strategyVersions.id, backtestRuns.versionId))
    .where(ownedBy(runId, worker));
  if (!row) return null;
  const definition = parseDefinition(row.definition);
  const ids = new Set<string>();
  for (const phase of [definition.entry, definition.exit]) {
    for (const o of phase.orders) ids.add(o.instrumentId);
  }
  for (const e of seriesExprs(definition)) ids.add(e.instrumentId);
  const rows =
    ids.size === 0
      ? []
      : await tx
          .select({
            id: instruments.id,
            symbol: instruments.symbol,
            assetClass: instruments.assetClass,
            lotSize: instruments.lotSize,
          })
          .from(instruments)
          .where(inArray(instruments.id, [...ids]));
  return {
    inputs: row.inputs as BacktestInputs,
    definition: definition,
    instruments: new Map(
      rows.map((r) => [r.id, { symbol: r.symbol, assetClass: r.assetClass, lotSize: r.lotSize }]),
    ),
    cancelRequested: row.cancelRequested,
  };
}

/**
 * Extends this worker's lease. Returns whether a cancel was requested, or null
 * if the lease is gone (another worker took over or the run ended).
 */
export async function renewLease(
  tx: Transaction,
  runId: string,
  worker: string,
  leaseSeconds: number,
): Promise<{ cancelRequested: boolean } | null> {
  const [row] = await tx
    .update(backtestRuns)
    .set({ leaseExpiresAt: sql`now() + make_interval(secs => ${leaseSeconds})` })
    .where(ownedBy(runId, worker))
    .returning({ cancelRequested: backtestRuns.cancelRequested });
  return row ?? null;
}

/** Stores the result and its trades. Returns the run's final status, or null if the lease was lost. */
export async function completeRun(
  tx: Transaction,
  userId: string,
  runId: string,
  worker: string,
  result: BacktestResult,
): Promise<BacktestRunStatus | null> {
  const { trades, metrics, ...rest } = result;
  const [row] = await tx
    .update(backtestRuns)
    .set({
      status: 'completed',
      engineVersion: result.engineVersion,
      dataVersions: result.dataVersions,
      summary: metrics,
      result: rest,
      finishedAt: sql`now()`,
      leaseOwner: null,
      leaseExpiresAt: null,
    })
    .where(and(ownedBy(runId, worker), eq(backtestRuns.cancelRequested, false)))
    .returning({ id: backtestRuns.id });
  if (!row) return finishCanceled(tx, runId, worker);
  if (trades.length > 0) {
    await tx.insert(backtestTrades).values(
      trades.map((t) => ({
        userId,
        runId,
        cycle: t.cycle,
        status: t.status,
        entryTime: t.entryTime ? new Date(t.entryTime) : null,
        exitTime: t.exitTime ? new Date(t.exitTime) : null,
        grossPnl: t.grossPnl,
        costs: t.costs,
        netPnl: t.netPnl,
        returnPct: t.returnPct,
        legs: t.legs,
      })),
    );
  }
  return 'completed';
}

/** Ends a run this worker holds as canceled, if a cancel was requested. */
export async function finishCanceled(
  tx: Transaction,
  runId: string,
  worker: string,
): Promise<BacktestRunStatus | null> {
  const [row] = await tx
    .update(backtestRuns)
    .set({ status: 'canceled', finishedAt: sql`now()`, leaseOwner: null, leaseExpiresAt: null })
    .where(and(ownedBy(runId, worker), eq(backtestRuns.cancelRequested, true)))
    .returning({ id: backtestRuns.id });
  return row ? 'canceled' : null;
}

/** Ends a run this worker holds as failed, with a message safe to show the user. */
export async function failRun(
  tx: Transaction,
  runId: string,
  worker: string,
  message: string,
): Promise<boolean> {
  const rows = await tx
    .update(backtestRuns)
    .set({
      status: 'failed',
      error: message.slice(0, 500),
      finishedAt: sql`now()`,
      leaseOwner: null,
      leaseExpiresAt: null,
    })
    .where(ownedBy(runId, worker))
    .returning({ id: backtestRuns.id });
  return rows.length > 0;
}
