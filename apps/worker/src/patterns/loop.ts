import { sharedFeedOwner, type Database } from '@tm/db';
import type { HistoricalDataProvider } from '@tm/domain';
import type { Logger } from 'pino';
import type { FundamentalsLoader } from '../fundamentals';
import { runPatternSnapshotPass, type PatternSnapshotOptions } from './snapshots';

/**
 * The pattern factor snapshot loop (pattern brief §3, ADR 0091): every few
 * minutes it does a few batches of members still behind the last closed day.
 * During the backfill that is work every pass; afterwards there is new work
 * once a day, after the close. It reads bars and filings through the sharing
 * admin's feeds (N237), like the ML snapshots and the global recordings.
 */

export interface PatternSnapshotLoop {
  stop(): Promise<void>;
}

export interface PatternSnapshotLoopOptions {
  db: Database;
  history: (userId: string) => HistoricalDataProvider;
  fundamentals: FundamentalsLoader;
  members: (userId: string) => Promise<string[]>;
  sessionMembers: () => Promise<string[]>;
  from: string;
  logger: Pick<Logger, 'info' | 'warn'>;
  now?: () => Date;
  pollMs?: number;
  batchesPerPass?: number;
}

const shortError = (e: unknown) =>
  (e instanceof Error ? e.message : 'failed').replace(/\s+/g, ' ').slice(0, 300);

export function startPatternSnapshotLoop(options: PatternSnapshotLoopOptions): PatternSnapshotLoop {
  const pollMs = options.pollMs ?? 300_000;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let quietSince = '';
  const attempts = new Map<string, string>();

  const pass = async () => {
    const owner = await options.db.transaction((tx) => sharedFeedOwner(tx));
    if (!owner) {
      const day = new Date().toISOString().slice(0, 10);
      if (quietSince !== day)
        options.logger.warn({}, 'pattern snapshots wait: no platform admin shares data feeds');
      quietSince = day;
      return;
    }
    const job: PatternSnapshotOptions = {
      db: options.db,
      history: options.history(owner),
      fundamentals: options.fundamentals,
      members: () => options.members(owner),
      sessionMembers: options.sessionMembers,
      userId: owner,
      now: options.now ?? (() => new Date()),
      from: options.from,
      logger: options.logger,
      maxBatches: options.batchesPerPass ?? 4,
      attempts,
    };
    const result = await runPatternSnapshotPass(job);
    if (result.members > 0)
      options.logger.info(
        { rows: result.rows, members: result.members, pending: result.pending },
        'pattern snapshot pass',
      );
    if (result.warnings.length > 0)
      options.logger.warn(
        { count: result.warnings.length, first: result.warnings.slice(0, 3) },
        'pattern snapshot data warnings',
      );
  };

  const tick = () => {
    if (stopped) return;
    running = pass()
      .catch((e: unknown) =>
        options.logger.warn({ err: shortError(e) }, 'pattern snapshot pass failed'),
      )
      .finally(() => {
        running = undefined;
        if (!stopped) timer = setTimeout(tick, pollMs);
      });
  };
  timer = setTimeout(tick, 15_000);
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}
