import {
  BarLoadError,
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
  type HistoricalDataProvider,
} from '@tm/domain';
import type { Logger } from 'pino';
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
  /** Resolves a built-in universe (the S&P 500) for a tenant (Design v1.2 item 1). */
  resolveUniverse?: (userId: string) => Promise<{ ids: string[]; warnings: string[] }>;
  /** Point-in-time company filings, for strategies with fundamental metrics (v1.2 item 6). */
  fundamentals?: FundamentalsLoader;
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

/**
 * The group members a run tests when only some were picked (N230), in the
 * group's order, and a warning naming picks that left the group since.
 */
export function pickMembers(
  members: readonly string[],
  symbols: readonly string[],
  symbolOf: (id: string) => string | undefined,
): { members: string[]; warning?: string } {
  const picked = new Set(symbols.map((s) => s.toUpperCase()));
  const kept = members.filter((id) => picked.has(symbolOf(id)?.toUpperCase() ?? ''));
  const found = new Set(kept.map((id) => symbolOf(id)?.toUpperCase()));
  const absent = [...picked].filter((s) => !found.has(s));
  const names = (list: string[]) => `${list.slice(0, 10).join(', ')}${list.length > 10 ? '…' : ''}`;
  if (kept.length === 0) {
    return {
      members: [],
      warning: `None of the instruments picked for this back test are in the group now: ${names([...picked])}`,
    };
  }
  if (absent.length === 0) return { members: kept };
  return {
    members: kept,
    warning: `${absent.length === 1 ? 'This pick is' : 'These picks are'} no longer in the group and ${absent.length === 1 ? 'was' : 'were'} left out: ${names(absent)}`,
  };
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

  try {
    const work = await inTenant((tx) => loadRunWork(tx, runId, workerId));
    if (!work) return 'lost';
    const provider =
      typeof options.provider === 'function'
        ? options.provider(userId, { background: work.inputs.interval === '5m' })
        : options.provider;
    if (work.cancelRequested)
      return (await inTenant((tx) => finishCanceled(tx, runId, workerId))) ?? 'lost';

    // A Selection group's universe: a list as stored, or the S&P 500 resolved now.
    let members = listMembers(work.definition);
    const universeWarnings: string[] = [];
    const instruments = new Map<string, InstrumentRef>(work.instruments);
    const trade = work.definition.trade;
    if (trade.kind === 'group' && trade.universe.type === 'builtin') {
      if (!options.resolveUniverse)
        throw new UnsupportedBarRequestError('This worker cannot resolve the S&P 500 universe');
      const resolved = await options.resolveUniverse(userId);
      members = resolved.ids;
      universeWarnings.push(...resolved.warnings);
      const refs = await inTenant((tx) => instrumentRefs(tx, members));
      for (const [id, ref] of refs) instruments.set(id, ref);
    }
    // Only the members picked for this run (N230); the rest of the group is left out.
    if (work.inputs.symbols && trade.kind === 'group') {
      const missing = members.filter((id) => !instruments.has(id));
      if (missing.length > 0) {
        const refs = await inTenant((tx) => instrumentRefs(tx, missing));
        for (const [id, ref] of refs) instruments.set(id, ref);
      }
      const narrowed = pickMembers(
        members,
        work.inputs.symbols,
        (id) => instruments.get(id)?.symbol,
      );
      if (narrowed.members.length === 0) throw new UnsupportedBarRequestError(narrowed.warning!);
      members = narrowed.members;
      if (narrowed.warning) universeWarnings.push(narrowed.warning);
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
      // A member whose bars fail is left out with a warning, not the whole run.
      new Set(members),
    );
    data.warnings.push(...universeWarnings);
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
            await inTenant((tx) => renewLease(tx, runId, workerId, leaseSeconds));
          },
        },
      );
      data.fundamentals = loaded.byId;
      data.warnings.push(...loaded.warnings);
    }
    // End-of-day options signals (options data brief v2 §5.3), read point in time by the engine.
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
    // Earnings, deals and rates (free data feeds brief v1 §6), read point in time by the engine.
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
