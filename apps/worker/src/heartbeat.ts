import { pruneRateLimits, recordHeartbeat, type Database } from '@tm/db';
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
 * Marks the worker alive for the system health check, and clears old rate-limit
 * windows about once an hour (ADR 0025).
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
