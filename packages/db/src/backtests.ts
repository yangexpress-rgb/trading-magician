import {
  BACKTEST_INTERVAL_NAMES,
  MAX_RANGE_DAYS,
  matchingBacktestInterval,
  planSeries,
  strategyInstruments,
  workloadProblem,
  type BacktestInputs,
  type BacktestMetrics,
  type BacktestResult,
  type InstrumentRef,
} from '@tm/backtest';
import {
  listMembers,
  parseDefinition,
  stockGroup,
  validateStrategy,
  type StrategyDefinition,
} from '@tm/domain';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { recordAudit } from './audit';
import type { Database, Transaction } from './client';
import { assertWithinLimit } from './entitlements';
import { backtestRuns, backtestTrades, instruments, strategyVersions } from './schema';
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
  /** Why the cycle exited; absent on runs from before v1.2. */
  exitReason?: BacktestResult['trades'][number]['exitReason'];
  /** Two-sided strategies (v1.2 item 8). */
  direction?: 'long' | 'short';
  group?: string;
  /** Risk-based sizing and ATR stop (v1.2 item 9). */
  sizing?: BacktestResult['trades'][number]['sizing'];
  atrStop?: BacktestResult['trades'][number]['atrStop'];
  expectedMove?: BacktestResult['trades'][number]['expectedMove'];
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
 * concurrent and daily runs (ADR 0022).
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

  const runInputs = await fitInputs(tx, pinned.definition, inputs);
  // Refuse a run too big for the worker before it is queued (ADR 0081).
  const tooBig = workloadProblem(
    planSeries(pinned.definition, runInputs, plannedMembers(pinned.definition, runInputs)),
  );
  if (tooBig) throw new StrategyError('invalid_state', tooBig);

  await assertWithinLimit(tx, userId, 'concurrentBacktests');
  await assertWithinLimit(tx, userId, 'backtestRunsPerDay');

  const [run] = await tx
    .insert(backtestRuns)
    .values({
      userId,
      strategyId,
      versionId: pinned.versionId,
      definitionHash: pinned.row.draftHash,
      inputs: runInputs,
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

/** A field problem in a back test request, shaped like the request's own checks. */
function inputsError(path: string, message: string): StrategyError {
  return new StrategyError('invalid_definition', 'Some back test inputs need attention', [
    { code: 'custom', path: [path], message, input: undefined },
  ]);
}

/**
 * The inputs a run keeps (ADR 0082): bars at the strategy's own size (N233),
 * whatever the request sent, within that size's longest range; and, for a
 * group, only members of it (N235).
 */
export async function fitInputs(
  tx: Transaction,
  definition: StrategyDefinition,
  inputs: BacktestInputs,
): Promise<BacktestInputs> {
  const { interval } = matchingBacktestInterval(definition);
  const days = (Date.parse(inputs.to) - Date.parse(inputs.from)) / 86_400_000;
  if (days > MAX_RANGE_DAYS[interval]) {
    const most = interval === '1d' ? '5 years' : interval === '1h' ? '1 year' : '31 days';
    throw inputsError(
      'lookback',
      `This strategy checks ${BACKTEST_INTERVAL_NAMES[interval].toLowerCase()} bars, so a back test can cover at most ${most}`,
    );
  }
  const { symbols, ...rest } = inputs;
  if (!symbols) return { ...rest, interval };
  const trade = definition.trade;
  if (trade.kind !== 'group') {
    throw inputsError(
      'symbols',
      'Only a strategy that trades a group can test some of its members',
    );
  }
  const picked = [...new Set(symbols.map((s) => s.toUpperCase()))];
  let inGroup: (symbol: string) => boolean;
  if (trade.universe.type === 'builtin') {
    const group = stockGroup(trade.universe.id).members;
    inGroup = (s) => group.has(s);
  } else {
    const refs = await instrumentRefs(tx, listMembers(definition));
    const members = new Set([...refs.values()].map((r) => r.symbol.toUpperCase()));
    inGroup = (s) => members.has(s);
  }
  const outside = picked.filter((s) => !inGroup(s));
  if (outside.length > 0) {
    throw inputsError(
      'symbols',
      `Not in this strategy's group: ${outside.slice(0, 10).join(', ')}${outside.length > 10 ? '…' : ''}`,
    );
  }
  return { ...rest, interval, symbols: picked };
}

/**
 * The members a run will test, for estimating its size before it is queued: a
 * list as stored, or one stand-in per stock of a built-in group (the worker
 * resolves the real ids, which can only be fewer).
 */
export function plannedMembers(def: StrategyDefinition, inputs?: BacktestInputs): string[] {
  // Only the picked members when the run tests some of the group (ADR 0082).
  if (inputs?.symbols && def.trade.kind === 'group')
    return inputs.symbols.map((s) => `planned:${s}`);
  const u = def.trade.kind === 'group' ? def.trade.universe : undefined;
  if (u?.type === 'builtin') return [...stockGroup(u.id).members].map((s) => `planned:${s}`);
  return listMembers(def);
}

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
      exitReason: backtestTrades.exitReason,
      direction: backtestTrades.direction,
      entryGroup: backtestTrades.entryGroup,
      sizing: backtestTrades.sizing,
      atrStop: backtestTrades.atrStop,
      expectedMove: backtestTrades.expectedMove,
    })
    .from(backtestTrades)
    .where(eq(backtestTrades.runId, runId))
    .orderBy(backtestTrades.cycle);
  return rows.map(({ exitReason, direction, entryGroup, sizing, atrStop, expectedMove, ...r }) => ({
    ...r,
    ...(exitReason ? { exitReason } : {}),
    ...(direction ? { direction } : {}),
    ...(entryGroup ? { group: entryGroup } : {}),
    ...(sizing ? { sizing } : {}),
    ...(atrStop ? { atrStop } : {}),
    ...(expectedMove ? { expectedMove } : {}),
  })) as BacktestTradeRow[];
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
  /** Which attempt this is (1 for the first claim), for the worker's stage log. */
  attempts: number;
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
      attempts: backtestRuns.attempts,
    })
    .from(backtestRuns)
    .innerJoin(strategyVersions, eq(strategyVersions.id, backtestRuns.versionId))
    .where(ownedBy(runId, worker));
  if (!row) return null;
  const definition = parseDefinition(row.definition);
  // A built-in universe's members are resolved by the worker (Design v1.2 item 1).
  const ids = new Set<string>(strategyInstruments(definition, listMembers(definition)));
  const rows =
    ids.size === 0
      ? []
      : await tx
          .select({
            id: instruments.id,
            symbol: instruments.symbol,
            assetClass: instruments.assetClass,
            lotSize: instruments.lotSize,
            shortable: instruments.shortable,
          })
          .from(instruments)
          .where(inArray(instruments.id, [...ids]));
  return {
    inputs: row.inputs as BacktestInputs,
    definition: definition,
    instruments: new Map(rows.map((r) => [r.id, instrumentRef(r)])),
    cancelRequested: row.cancelRequested,
    attempts: row.attempts,
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
        exitReason: t.exitReason ?? null,
        direction: t.direction ?? null,
        entryGroup: t.group ?? null,
        sizing: t.sizing ?? null,
        atrStop: t.atrStop ?? null,
        expectedMove: t.expectedMove ?? null,
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

const instrumentRef = (r: {
  symbol: string;
  assetClass: string;
  lotSize: string;
  shortable: boolean | null;
}): InstrumentRef => ({
  symbol: r.symbol,
  assetClass: r.assetClass,
  lotSize: r.lotSize,
  ...(r.shortable !== null ? { shortable: r.shortable } : {}),
});

/** Symbol, asset class and lot size of instruments, e.g. a resolved universe's members. */
export async function instrumentRefs(
  tx: Transaction,
  ids: readonly string[],
): Promise<Map<string, InstrumentRef>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({
      id: instruments.id,
      symbol: instruments.symbol,
      assetClass: instruments.assetClass,
      lotSize: instruments.lotSize,
      shortable: instruments.shortable,
    })
    .from(instruments)
    .where(inArray(instruments.id, [...ids]));
  return new Map(rows.map((r) => [r.id, instrumentRef(r)]));
}
