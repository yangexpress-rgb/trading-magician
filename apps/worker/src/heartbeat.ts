import {
  expireShares,
  pruneAgentLog,
  pruneRateLimits,
  purgeDeletedAccounts,
  recordHeartbeat,
  type Database,
} from '@tm/db';
import type { Logger } from 'pino';

export interface HeartbeatLoop {
  stop(): Promise<void>;
}

export interface HeartbeatOptions {
  db: Database;
  instance: string;
  logger: Logger;
  everyMs: number;
}

/**
 * Marks the worker alive for the system health check, and about once an hour
 * clears old rate-limit windows (ADR 0025), purges accounts deleted 30 days
 * ago (§20 #14), expires shares nobody answered in 30 days (ADR 0056) and
 * drops agent activity older than 90 days (ADR 0092).
 */
export function startHeartbeatLoop(options: HeartbeatOptions): HeartbeatLoop {
  let running = true;
  let wake: (() => void) | undefined;
  let lastPrune = 0;
  const sleep = () =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, options.everyMs);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  const done = (async () => {
    while (running) {
      try {
        await recordHeartbeat(options.db, 'worker', options.instance);
        if (Date.now() - lastPrune >= 3_600_000) {
          lastPrune = Date.now();
          await pruneRateLimits(options.db);
          const purged = await purgeDeletedAccounts(options.db);
          if (purged > 0) options.logger.info({ purged }, 'purged deleted accounts');
          const expired = await expireShares(options.db);
          if (expired > 0) options.logger.info({ expired }, 'expired unanswered shares');
          const calls = await pruneAgentLog(options.db);
          if (calls > 0) options.logger.info({ calls }, 'pruned agent activity');
        }
      } catch (error) {
        const e = error as { name?: string; message?: string };
        options.logger.warn({ err: { name: e.name, message: e.message } }, 'heartbeat failed');
      }
      if (running) await sleep();
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
