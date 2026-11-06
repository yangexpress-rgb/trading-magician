import {
  loadData,
  planSeries,
  simulate,
  watchOnlyInstruments,
  type InstrumentRef,
} from '@tm/backtest';
import {
  claimBacktestRun,
  instrumentRefs,
  completeRun,
  failRun,
  finishCanceled,
  loadRunWork,
  renewLease,
  withTenant,
  type BacktestRunStatus,
  type Database,
} from '@tm/db';
import { listMembers, UnsupportedBarRequestError, type HistoricalDataProvider } from '@tm/domain';
import type { Logger } from 'pino';

/**
 * Runs queued back tests (Design v1.0 §7.2, ADR 0009). One run at a time per
 * loop: claim, load the pinned rules and the bars, simulate, store. The lease
 * is renewed between steps, and a cancel request is honoured at each one. A
 * worker that dies leaves its lease to lapse; the queue then hands the run to
 * another worker, up to `maxAttempts`.
 */

export interface BacktestWorkerOptions {
  db: Database;
  /** Bars for a run: one provider, or one per tenant that resolves its routes (ADR 0017). */
  provider: HistoricalDataProvider | ((userId: string) => HistoricalDataProvider);
  workerId: string;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  leaseSeconds?: number;
  maxAttempts?: number;
  /** Resolves a built-in universe (the S&P 500) for a tenant (Design v1.2 item 1). */
  resolveUniverse?: (userId: string) => Promise<{ ids: string[]; warnings: string[] }>;
}

export type ProcessOutcome = 'idle' | 'lost' | BacktestRunStatus;

const GENERIC_FAILURE = 'The back test could not be completed. Try again, or change the dates.';

/** A message safe to show the user: data problems are explained, anything else is generic. */
function userMessage(error: unknown): string {
  if (error instanceof UnsupportedBarRequestError) return error.message;
  if (error instanceof Error && error.message.startsWith('The strategy uses')) return error.message;
  return GENERIC_FAILURE;
}

export async function processNextRun(options: BacktestWorkerOptions): Promise<ProcessOutcome> {
  const { db, workerId, logger } = options;
  const leaseSeconds = options.leaseSeconds ?? 120;
  const claim = await claimBacktestRun(db, workerId, {
    leaseSeconds,
    maxAttempts: options.maxAttempts ?? 3,
  });
  if (!claim) return 'idle';
  const { runId, userId } = claim;
  const provider =
    typeof options.provider === 'function' ? options.provider(userId) : options.provider;
  const inTenant = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db, { userId }, fn);
  const started = Date.now();
  logger.info({ runId }, 'back test claimed');

  try {
    const work = await inTenant((tx) => loadRunWork(tx, runId, workerId));
    if (!work) return 'lost';
    if (work.cancelRequested)
      return (await inTenant((tx) => finishCanceled(tx, runId, workerId))) ?? 'lost';

    // A Selection group's universe: a list as stored, or the S&P 500 resolved now.
    let members = listMembers(work.definition);
    const universeWarnings: string[] = [];
    const instruments = new Map<string, InstrumentRef>(work.instruments);
    const universe = work.definition.entry.selection?.universe;
    if (work.definition.entry.kind === 'selection' && universe?.type === 'builtin') {
      if (!options.resolveUniverse)
        throw new UnsupportedBarRequestError('This worker cannot resolve the S&P 500 universe');
      const resolved = await options.resolveUniverse(userId);
      members = resolved.ids;
      universeWarnings.push(...resolved.warnings);
      const refs = await inTenant((tx) => instrumentRefs(tx, members));
      for (const [id, ref] of refs) instruments.set(id, ref);
    }
    // Hundreds of members take a while to load; keep the lease while they do.
    let lastRenew = Date.now();
    const data = await loadData(
      provider,
      planSeries(work.definition, work.inputs, members, watchOnlyInstruments(instruments)),
      instruments,
      async () => {
        if (Date.now() - lastRenew < (leaseSeconds * 1000) / 3) return;
        lastRenew = Date.now();
        await inTenant((tx) => renewLease(tx, runId, workerId, leaseSeconds));
      },
    );
    data.warnings.push(...universeWarnings);
    const lease = await inTenant((tx) => renewLease(tx, runId, workerId, leaseSeconds));
    if (!lease) return 'lost';
    if (lease.cancelRequested) {
      return (await inTenant((tx) => finishCanceled(tx, runId, workerId))) ?? 'lost';
    }

    const result = simulate({
      definition: work.definition,
      instruments,
      inputs: work.inputs,
      data,
      members,
    });
    const status = await inTenant((tx) => completeRun(tx, userId, runId, workerId, result));
    logger.info({ runId, status, ms: Date.now() - started }, 'back test finished');
    return status ?? 'lost';
  } catch (error) {
    const e = error as { name?: string; message?: string };
    logger.error({ runId, err: { name: e.name, message: e.message } }, 'back test failed');
    const failed = await inTenant((tx) => failRun(tx, runId, workerId, userMessage(error)));
    return failed ? 'failed' : 'lost';
  }
}

export interface BacktestLoop {
  stop: () => Promise<void>;
}

/** Polls the queue until stopped, sleeping `pollMs` whenever it is empty. */
export function startBacktestLoop(
  options: BacktestWorkerOptions & { pollMs?: number },
): BacktestLoop {
  const pollMs = options.pollMs ?? 1000;
  let running = true;
  let wake: (() => void) | undefined;
  const sleep = () =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, pollMs);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  const done = (async () => {
    while (running) {
      let outcome: ProcessOutcome = 'idle';
      try {
        outcome = await processNextRun(options);
      } catch (error) {
        // The queue itself is unreachable (database down): back off and retry.
        const e = error as { name?: string; message?: string };
        options.logger.warn(
          { err: { name: e.name, message: e.message } },
          'back-test queue unavailable',
        );
      }
      if (outcome === 'idle' && running) await sleep();
    }
  })();

  return {
    stop: async () => {
      running = false;
      wake?.();
      await done;
    },
  };
}
