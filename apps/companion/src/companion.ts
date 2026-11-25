import { arch, platform } from 'node:os';
import { CompanionClient } from './api';
import type { CompanionConfig } from './config';
import { runJobs, type Job, type SchedulerHooks, type StopReason } from './scheduler';
import { startLocalStore, type LocalStore } from './store';
import { pullReference, recordJob } from './sync';

/** The companion's version, sent with each hello. */
export const COMPANION_VERSION = '0.1.0';
/** The cloud counts a companion offline after 48 hours; a hello every 15 minutes keeps it current. */
export const HELLO_EVERY_MS = 15 * 60_000;
/** Instruments and membership change slowly; once a day, and at every start. */
export const REFERENCE_EVERY_MS = 24 * 3_600_000;

export const platformName = () => `${platform()}-${arch()}`;

export function companionJobs(store: LocalStore, client: CompanionClient): Job[] {
  return [
    {
      name: 'hello',
      everyMs: HELLO_EVERY_MS,
      run: async () => {
        const reply = await client.hello({ version: COMPANION_VERSION, platform: platformName() });
        return { seenAt: reply.seenAt };
      },
    },
    {
      name: 'reference',
      everyMs: REFERENCE_EVERY_MS,
      run: () => pullReference(store.sql, client),
    },
  ];
}

export interface RunOptions {
  home: string;
  config: CompanionConfig;
  signal: AbortSignal;
  log: (line: string) => void;
  fetch?: typeof fetch;
  hooks?: Omit<SchedulerHooks, 'log' | 'onResult'>;
}

/** Starts the local store and runs the jobs until stopped or unpaired. */
export async function runCompanion(options: RunOptions): Promise<StopReason> {
  const store = await startLocalStore({
    home: options.home,
    port: options.config.pgPort,
    password: options.config.pgPassword,
    log: options.log,
  });
  try {
    const client = new CompanionClient({
      apiBase: options.config.apiBase,
      token: options.config.token,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    return await runJobs(companionJobs(store, client), options.signal, {
      ...options.hooks,
      log: options.log,
      onResult: (job, outcome) => recordJob(store.sql, job, outcome),
    });
  } finally {
    await store.stop();
  }
}
