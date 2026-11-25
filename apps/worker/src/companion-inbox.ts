import { applyCompanionPushes, type Database } from '@tm/db';
import type { Logger } from 'pino';

/**
 * Applies the Local Companion's pushes (ADR 0117): ML runs with their
 * predictions go into Core, evaluations and reports into the Research Store.
 * The web app only queues them; this loop writes them with the worker's own
 * login. Every minute; a quiet pass costs one indexed read.
 */

export interface CompanionInboxLoop {
  stop(): Promise<void>;
}

export function startCompanionInboxLoop(options: {
  core: Database;
  research: Database;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  pollMs?: number;
}): CompanionInboxLoop {
  const pollMs = options.pollMs ?? 60_000;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;

  const pass = async () => {
    try {
      const applied = await applyCompanionPushes({
        core: options.core,
        research: options.research,
      });
      for (const a of applied) {
        if (a.error)
          options.logger.warn(
            { push: a.id, kind: a.kind, error: a.error },
            'companion push refused',
          );
        else
          options.logger.info(
            { push: a.id, kind: a.kind, result: a.result },
            'companion push applied',
          );
      }
    } catch (err) {
      options.logger.error({ err }, 'companion inbox pass failed');
    }
  };

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      running = pass().finally(schedule);
    }, pollMs);
  };
  running = pass().finally(schedule);

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running;
    },
  };
}
