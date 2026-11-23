import {
  saveShortInterestSettlement,
  settlementsWithNewlyResolved,
  shortInterestCoverage,
  shortInterestSymbols,
  storedSettlements,
  type Database,
  type ShortInterestCoverage,
} from '@tm/db';
import { addDays, nyDate, shortInterestPublicationDate } from '@tm/domain';
import type { FinraClient } from './finra';

/**
 * The FINRA short interest job (data inputs part 2, item B, N323, ADR 0111),
 * mirroring the events loop: each pass reads the settlement dates FINRA has
 * published, stores any it has not stored yet (newest first, a few a pass, so
 * the 2017 → today backfill resumes where it stopped), and re-reads the most
 * recent stored settlement once a day for revisions. Without a credential
 * it never starts; a failing pass is logged and retried later.
 */

export interface ShortInterestJobOptions {
  db: Database;
  client: FinraClient;
  logger: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
  now?: () => Date;
  /** Settlements fetched per pass (backfill pace). */
  perPass?: number;
  /** The research universe for the coverage report (B4); absent: no report. */
  members?: () => Promise<string[]>;
}

export interface ShortInterestPassResult {
  fetched: string[];
  rechecked: string | undefined;
  /** Published settlements still not stored after this pass. */
  pending: number;
  coverage?: ShortInterestCoverage;
}

/**
 * The day a settlement's rows count as public. FINRA's schedule date, unless
 * the job first saw a recent settlement later than that (FINRA published
 * late): then the day it was seen, so nothing is read before it was public.
 * Older settlements (a backfill) keep the schedule date.
 */
export function availableDateFor(settlementDate: string, today: string): string {
  const scheduled = shortInterestPublicationDate(settlementDate);
  const recent = today <= addDays(scheduled, 30);
  return recent && today > scheduled ? today : scheduled;
}

export async function runShortInterestPass(
  o: ShortInterestJobOptions,
  state: { recheckedOn?: string } = {},
): Promise<ShortInterestPassResult> {
  const now = (o.now ?? (() => new Date()))();
  const today = nyDate(now);
  const published = await o.client.settlementDates();
  const stored = await storedSettlements(o.db);
  const have = new Set(stored.map((s) => s.settlementDate));
  const symbols = await o.db.transaction((tx) => shortInterestSymbols(tx));
  // Settlements not stored yet, newest first; then stored ones that listed a symbol
  // registered since (its history would otherwise stay empty).
  const missing = [
    ...published.filter((d) => !have.has(d)).sort((a, b) => b.localeCompare(a)),
    ...(await settlementsWithNewlyResolved(o.db, symbols)),
  ];
  const todo = missing.slice(0, o.perPass ?? 6);
  const firstSeen = new Map(stored.map((s) => [s.settlementDate, s.availableDate]));
  const result: ShortInterestPassResult = {
    fetched: [],
    rechecked: undefined,
    pending: missing.length - todo.length,
  };
  for (const date of todo) {
    const rows = await o.client.settlement(date);
    const available = firstSeen.get(date) ?? availableDateFor(date, today);
    const saved = await saveShortInterestSettlement(o.db, date, available, rows, symbols);
    result.fetched.push(date);
    o.logger.info(
      {
        settlement: date,
        available,
        published: rows.length,
        stored: saved.stored,
        unresolved: saved.unresolved.length,
      },
      'short interest settlement stored',
    );
  }
  // The latest stored settlement, re-read once a day: FINRA republishes corrections.
  const latest = stored[0];
  if (latest && !todo.includes(latest.settlementDate) && state.recheckedOn !== today) {
    const rows = await o.client.settlement(latest.settlementDate);
    const saved = await saveShortInterestSettlement(
      o.db,
      latest.settlementDate,
      latest.availableDate,
      rows,
      symbols,
    );
    state.recheckedOn = today;
    result.rechecked = latest.settlementDate;
    if (saved.changed > 0)
      o.logger.info(
        { settlement: latest.settlementDate, revised: saved.changed },
        'short interest revisions stored',
      );
  }
  if (result.pending === 0 && result.fetched.length > 0 && o.members) {
    result.coverage = await shortInterestCoverage(o.db, await o.members());
    o.logger.info({ ...result.coverage }, 'short interest coverage');
  }
  return result;
}

export interface ShortInterestLoop {
  stop(): Promise<void>;
}

/**
 * Every six hours; a minute apart while a backfill has settlements left.
 */
export function startShortInterestLoop(
  o: ShortInterestJobOptions & { pollMs?: number; backlogPollMs?: number },
): ShortInterestLoop {
  const pollMs = o.pollMs ?? 6 * 3600_000;
  const backlogMs = o.backlogPollMs ?? 60_000;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  const state: { recheckedOn?: string } = {};
  const tick = () => {
    if (stopped) return;
    let next = pollMs;
    running = runShortInterestPass(o, state)
      .then((r) => {
        if (r.pending > 0) next = backlogMs;
      })
      .catch((e: unknown) =>
        o.logger.warn(
          { err: (e instanceof Error ? e.message : 'failed').slice(0, 200) },
          'short interest pass failed',
        ),
      )
      .finally(() => {
        running = undefined;
        if (!stopped) timer = setTimeout(tick, next);
      });
  };
  timer = setTimeout(tick, 30_000);
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}
