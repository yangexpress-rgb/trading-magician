import { CompanionApiError } from './api';

/**
 * A small job loop. Each job runs at start (the catch-up after time offline,
 * A4) and then every `everyMs`. A failed job is tried again sooner, after
 * `retryMs`, or after the cloud's Retry-After. A final error (the pairing was
 * removed or expired) stops everything: the person has to pair again.
 */

export interface Job {
  name: string;
  everyMs: number;
  /** Returns a short detail for the log and status. */
  run: () => Promise<Record<string, unknown> | undefined>;
}

export interface SchedulerHooks {
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  log?: (line: string) => void;
  onResult?: (
    job: string,
    outcome: { ok: true; detail?: Record<string, unknown> } | { ok: false; error: string },
  ) => Promise<void>;
  retryMs?: number;
  tickMs?: number;
}

export type StopReason = { kind: 'aborted' } | { kind: 'unpaired'; message: string };

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

export async function runJobs(
  jobs: Job[],
  signal: AbortSignal,
  hooks: SchedulerHooks = {},
): Promise<StopReason> {
  const now = hooks.now ?? Date.now;
  const sleep = hooks.sleep ?? defaultSleep;
  const log = hooks.log ?? (() => undefined);
  const retryMs = hooks.retryMs ?? 5 * 60_000;
  const tickMs = hooks.tickMs ?? 15_000;
  const due = new Map(jobs.map((j) => [j.name, now()]));

  while (!signal.aborted) {
    for (const job of jobs) {
      if (signal.aborted) break;
      if ((due.get(job.name) ?? 0) > now()) continue;
      try {
        const detail = await job.run();
        due.set(job.name, now() + job.everyMs);
        await hooks.onResult?.(job.name, detail ? { ok: true, detail } : { ok: true });
        log(`${job.name}: ok${detail ? ` ${JSON.stringify(detail)}` : ''}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await hooks.onResult?.(job.name, { ok: false, error: message }).catch(() => undefined);
        if (error instanceof CompanionApiError && error.final) {
          log(`${job.name}: ${message}`);
          return { kind: 'unpaired', message };
        }
        const wait =
          error instanceof CompanionApiError && error.retryAfterSeconds
            ? error.retryAfterSeconds * 1000
            : Math.min(retryMs, job.everyMs);
        due.set(job.name, now() + wait);
        log(`${job.name}: failed, trying again in ${Math.round(wait / 1000)} s: ${message}`);
      }
    }
    if (signal.aborted) break;
    const next = Math.min(...due.values()) - now();
    await sleep(Math.max(1_000, Math.min(tickMs, next)), signal);
  }
  return { kind: 'aborted' };
}
