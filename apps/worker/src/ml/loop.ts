import { sharedFeedOwner, type Database } from '@tm/db';
import type { Logger } from 'pino';
import { runSnapshotPass, type SnapshotJobOptions } from './snapshots';

/**
 * The ML snapshot loop (ML brief v1 §5, ADR 0086): every few minutes it looks
 * for prediction dates without snapshots and labels whose window has passed,
 * and does one chunk of them. While the history is being filled (the §9
 * backfill) that is a chunk every pass; afterwards there is new work once a
 * month. The job reads bars and filings through the sharing admin's feeds
 * (N237), like the global options and events recordings.
 */

export interface MlSnapshotLoop {
  stop(): Promise<void>;
}

export interface MlSnapshotLoopOptions extends Omit<
  SnapshotJobOptions,
  'userId' | 'history' | 'maxChunks' | 'now' | 'logger'
> {
  db: Database;
  history: (userId: string) => SnapshotJobOptions['history'];
  logger: Pick<Logger, 'info' | 'warn'>;
  now?: () => Date;
  pollMs?: number;
}

const shortError = (e: unknown) =>
  (e instanceof Error ? e.message : 'failed').replace(/\s+/g, ' ').slice(0, 300);

export function startMlSnapshotLoop(options: MlSnapshotLoopOptions): MlSnapshotLoop {
  const pollMs = options.pollMs ?? 600_000;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let quietSince = '';

  const pass = async () => {
    const owner = await options.db.transaction((tx) => sharedFeedOwner(tx));
    if (!owner) {
      const day = new Date().toISOString().slice(0, 10);
      if (quietSince !== day)
        options.logger.warn({}, 'ml snapshots wait: no platform admin shares data feeds');
      quietSince = day;
      return;
    }
    const result = await runSnapshotPass({
      ...options,
      userId: owner,
      history: options.history(owner),
      now: options.now ?? (() => new Date()),
      maxChunks: 1,
    });
    if (result.snapshots.length > 0 || result.labels > 0)
      options.logger.info(
        {
          snapshots: result.snapshots.length,
          labels: result.labels,
          pendingSnapshots: result.pendingSnapshots,
          pendingLabels: result.pendingLabels,
        },
        'ml snapshot pass',
      );
  };

  const tick = () => {
    if (stopped) return;
    running = pass()
      .catch((e: unknown) => options.logger.warn({ err: shortError(e) }, 'ml snapshot pass failed'))
      .finally(() => {
        running = undefined;
        if (!stopped) timer = setTimeout(tick, pollMs);
      });
  };
  timer = setTimeout(tick, 5_000);
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}
