import {
  BarLoadError,
  estimateWorkload,
  workloadProblem,
  loadData,
  dealsBeforeFirstDate,
  earningsBeforeFirstDate,
  optionsBeforeFirstDate,
  ratesBeforeFirstDate,
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
  loadOptionSignals,
  loadRunWork,
  renewLease,
  withTenant,
  type BacktestRunStatus,
  type Database,
  loadEventData,
} from '@tm/db';
import {
  fundamentalInstruments,
  listMembers,
  eventInstruments,
  optionInstruments,
  UnsupportedBarRequestError,
  type BuiltinUniverse,
  type HistoricalDataProvider,
} from '@tm/domain';
import type { Logger } from 'pino';
import { BacktestTrace } from './backtest-trace';
import { NO_COMPANY_FEED, type FundamentalsLoader } from './fundamentals';

/**
 * Runs queued back tests (Design v1.0 §7.2, ADR 0009). One run at a time per
 * loop: claim, load the pinned rules and the bars, simulate, store. The lease
 * is renewed between steps, and a cancel request is honoured at each one. A
 * worker that dies leaves its lease to lapse; the queue then hands the run to
 * another worker, up to `maxAttempts`.
 */

export interface BacktestWorkerOptions {
  db: Database;
  /**
   * Bars for a run: one provider, or one per tenant that resolves its routes
   * (ADR 0017). A 5-minute run asks for its bars as background work, paced
   * within each Alpaca key's request budget (ADR 0063).
   */
  provider:
    | HistoricalDataProvider
    | ((userId: string, run: { background: boolean }) => HistoricalDataProvider);
  workerId: string;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  leaseSeconds?: number;
  maxAttempts?: number;
  /** Resolves a built-in stock group for a tenant (Design v1.2 item 1, ADR 0080). */
  resolveUniverse?: (
    userId: string,
    group: BuiltinUniverse,
  ) => Promise<{ ids: string[]; warnings: string[] }>;
  /** Point-in-time company filings, for strategies with fundamental metrics (v1.2 item 6). */
  fundamentals?: FundamentalsLoader;
  /**
   * Lease taken just before the simulation, which runs without yielding and so
   * can't renew (ADR 0081). Defaults to 10 minutes; the workload limit keeps
   * simulations far shorter.
   */
  simulateLeaseSeconds?: number;
  /** Most estimated bars a run may hold (tests lower it; ADR 0081). */
  maxBars?: number;
  /** How often a running attempt logs its stage and memory (0 turns it off). */
  heartbeatMs?: number;
}

export type ProcessOutcome = 'idle' | 'lost' | BacktestRunStatus;

const GENERIC_FAILURE = 'The back test could not be completed. Try again, or change the dates.';

/**
 * What to tell the person (v1.2 review: "surface the real error"). Data
 * problems explain themselves and name the symbol; anything else gives the
 * error's kind and text with addresses and anything key-like removed.
 */
export function userMessage(error: unknown): string {
  if (error instanceof UnsupportedBarRequestError || error instanceof BarLoadError)
    return error.message.slice(0, 500);
  if (error instanceof Error && error.message.startsWith('The strategy uses')) return error.message;
  if (error instanceof Error && error.message) {
    const text = scrub(error.message).slice(0, 300);
    return `${GENERIC_FAILURE} Reason: ${error.name && error.name !== 'Error' ? `${error.name}: ` : ''}${text}`;
  }
  return GENERIC_FAILURE;
}

/** Drops URLs, connection strings and long token-like runs from an error's text. */
export function scrub(text: string): string {
  return text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[address]')
    .replace(/\b[A-Za-z0-9_\-+/=]{24,}\b/g, '[hidden]')
    .replace(/\s+/g, ' ')
    .trim();
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
  const inTenant = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db, { userId }, fn);
  const started = Date.now();
  logger.info({ runId }, 'back test claimed');
  const maxAttempts = options.maxAttempts ?? 3;
  const trace = new BacktestTrace(
    logger,
    { runId, workerId, leaseSeconds, maxAttempts },
    options.heartbeatMs,
  );
  const renew = async (seconds = leaseSeconds) => {
    const lease = await inTenant((tx) => renewLease(tx, runId, workerId, seconds));
    trace.renewed(lease !== null);
    return lease;
  };
  let outcome: ProcessOutcome = 'lost';
  try {
    outcome = await attempt();
    return outcome;
  } finally {
    trace.finish(outcome);
  }

  async function attempt(): Promise<ProcessOutcome> {
    try {
      let done = trace.stage('load_run');
      const work = await inTenant((tx) => loadRunWork(tx, runId, workerId));
      if (!work) return 'lost';
      trace.attempt = work.attempts;
      done({ interval: work.inputs.interval, from: work.inputs.from, to: work.inputs.to });
      const inner =
        typeof options.provider === 'function'
          ? options.provider(userId, { background: work.inputs.interval === '5m' })
          : options.provider;
      const provider = trace.provider(inner);
      if (work.cancelRequested)
        return (await inTenant((tx) => finishCanceled(tx, runId, workerId))) ?? 'lost';

      // A Selection group's universe: a list as stored, or a built-in stock group resolved now.
      let members = listMembers(work.definition);
      const universeWarnings: string[] = [];
      const instruments = new Map<string, InstrumentRef>(work.instruments);
      const trade = work.definition.trade;
      done = trace.stage('resolve_universe');
      if (trade.kind === 'group' && trade.universe.type === 'builtin') {
        if (!options.resolveUniverse)
          throw new UnsupportedBarRequestError('This worker cannot resolve built-in stock groups');
        const resolved = await options.resolveUniverse(userId, trade.universe.id);
        members = resolved.ids;
        universeWarnings.push(...resolved.warnings);
        const refs = await inTenant((tx) => instrumentRefs(tx, members));
        for (const [id, ref] of refs) instruments.set(id, ref);
      }
      done({ members: members.length, warnings: universeWarnings.length });
      done = trace.stage('plan_series');
      const plans = planSeries(
        work.definition,
        work.inputs,
        members,
        watchOnlyInstruments(instruments),
      );
      const workload = estimateWorkload(plans);
      done({ ...workload });
      // Too much price data crashes the worker part way through loading (ADR 0081).
      const tooBig = workloadProblem(plans, options.maxBars);
      if (tooBig) throw new UnsupportedBarRequestError(tooBig);
      // Hundreds of members take a while to load; keep the lease while they do.
      let lastRenew = Date.now();
      done = trace.stage('load_bars');
      const data = await loadData(
        provider,
        plans,
        instruments,
        async () => {
          if (Date.now() - lastRenew < (leaseSeconds * 1000) / 3) return;
          lastRenew = Date.now();
          await renew();
        },
        // A member whose bars fail is left out with a warning, not the whole run.
        new Set(members),
      );
      done({
        seriesLoaded: data.series.size,
        barsLoaded: [...data.series.values()].reduce((n, b) => n + b.length, 0),
        loads: trace.loadsByInterval(),
      });
      data.warnings.push(...universeWarnings);
      done = trace.stage('load_fundamentals');
      const companies = fundamentalInstruments(work.definition, members);
      if (companies.length > 0) {
        if (!options.fundamentals) throw new UnsupportedBarRequestError(NO_COMPANY_FEED);
        const loaded = await options.fundamentals(
          userId,
          companies.flatMap((id) => {
            const ref = instruments.get(id);
            return ref ? [{ id, symbol: ref.symbol }] : [];
          }),
          {
            onProgress: async () => {
              if (Date.now() - lastRenew < (leaseSeconds * 1000) / 3) return;
              lastRenew = Date.now();
              await renew();
            },
          },
        );
        data.fundamentals = loaded.byId;
        data.warnings.push(...loaded.warnings);
      }
      done({ companies: companies.length });
      // End-of-day options signals (options data brief v2 §5.3), read point in time by the engine.
      done = trace.stage('load_options');
      const underlyings = optionInstruments(work.definition, members);
      if (underlyings.length > 0) {
        data.options = await loadOptionSignals(db, underlyings);
        for (const id of underlyings) {
          // A Selection member without options data just reads unknown; a named underlying fails.
          if (members.includes(id)) continue;
          const problem = optionsBeforeFirstDate(
            instruments.get(id)?.symbol ?? 'this instrument',
            data.options.get(id),
            work.inputs.to,
          );
          if (problem) throw new UnsupportedBarRequestError(problem);
        }
      }
      done({ underlyings: underlyings.length });
      // Earnings, deals and rates (free data feeds brief v1 §6), read point in time by the engine.
      done = trace.stage('load_events');
      const eventReads = eventInstruments(work.definition, members);
      if (eventReads.size > 0) {
        data.events = await loadEventData(db, eventReads);
        for (const [id, metrics] of eventReads) {
          // A Selection member without event data just reads unknown; a named stock fails.
          if (members.includes(id)) continue;
          const symbol = instruments.get(id)?.symbol ?? 'this instrument';
          const reads = [...metrics];
          const problem =
            (reads.some((m) => m.startsWith('earnings.') && m !== 'earnings.next_earnings_days')
              ? earningsBeforeFirstDate(symbol, data.events, id, work.inputs.to)
              : undefined) ??
            (reads.some((m) => m.startsWith('deals.'))
              ? dealsBeforeFirstDate(data.events, work.inputs.to)
              : undefined) ??
            (reads.some((m) => m.startsWith('rates.'))
              ? ratesBeforeFirstDate(data.events, work.inputs.to)
              : undefined);
          if (problem) throw new UnsupportedBarRequestError(problem);
        }
      }
      done({
        instruments: eventReads.size,
        metrics: [...new Set([...eventReads.values()].flatMap((m) => [...m]))],
        earningsReleases: data.events ? count(data.events.earnings) : 0,
        calendarRows: data.events ? count(data.events.calendar) : 0,
      });
      // The simulation can't renew while it runs, so it starts on a longer lease
      // and no other worker can claim the run under it (ADR 0081).
      done = trace.stage('renew_before_simulate');
      const simulateLease = Math.max(leaseSeconds, options.simulateLeaseSeconds ?? 600);
      const lease = await renew(simulateLease);
      done({ leaseSeconds: simulateLease });
      if (!lease) return 'lost';
      if (lease.cancelRequested) {
        return (await inTenant((tx) => finishCanceled(tx, runId, workerId))) ?? 'lost';
      }

      done = trace.stage('simulate');
      const result = simulate({
        definition: work.definition,
        instruments,
        inputs: work.inputs,
        data,
        members,
      });
      done({
        steps: result.equity.length,
        instruments: members.length || instruments.size,
        cycles: result.metrics.cycles,
        trades: result.trades.length,
      });
      done = trace.stage('save_result');
      const status = await inTenant((tx) => completeRun(tx, userId, runId, workerId, result));
      done({ status, trades: result.trades.length, resultBytes: jsonBytes(result) });
      logger.info({ runId, status, ms: Date.now() - started }, 'back test finished');
      return status ?? 'lost';
    } catch (error) {
      const e = error as { name?: string; message?: string };
      logger.error({ runId, err: { name: e.name, message: e.message } }, 'back test failed');
      const failed = await inTenant((tx) => failRun(tx, runId, workerId, userMessage(error)));
      return failed ? 'failed' : 'lost';
    }
  }
}

/** Size of a result as stored, or -1 when it can't be measured. */
function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return -1;
  }
}

/** Rows held across a map of lists (a count for the stage log). */
function count(map: ReadonlyMap<string, readonly unknown[]>): number {
  let n = 0;
  for (const list of map.values()) n += list.length;
  return n;
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
