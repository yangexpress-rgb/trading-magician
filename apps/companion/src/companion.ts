import { arch, platform } from 'node:os';
import { CompanionApiError, CompanionClient } from './api';
import type { CompanionConfig } from './config';
import { runJobs, type Job, type SchedulerHooks, type StopReason } from './scheduler';
import { startLocalStore, type LocalStore } from './store';
import { pullReference, recordJob } from './sync';
import { CloudData, type CloudDataOptions } from './cloud-data';
import { runFeaturePass } from './features';
import { pushMlOutputs, refusedPushes, syncMlMirror } from './ml';
import { ensurePython, runTrainer, type RunResult } from './python';

/** The companion's version, sent with each hello. */
export const COMPANION_VERSION = '0.2.0';
/** The cloud counts a companion offline after 48 hours; a hello every 15 minutes keeps it current. */
export const HELLO_EVERY_MS = 15 * 60_000;
/** Instruments and membership change slowly; once a day, and at every start. */
export const REFERENCE_EVERY_MS = 24 * 3_600_000;

/** The trainer's catch-up: daily, like the cloud's cron (a no-op when nothing is due). */
export const ML_EVERY_MS = 24 * 3_600_000;
/** The feature writer, like the cloud's snapshot loop: a chunk of dates every ten minutes. */
export const FEATURES_EVERY_MS = 10 * 60_000;

export const platformName = () => `${platform()}-${arch()}`;

/** Runs the trainer against the local store; tests pass a stand-in. */
export type TrainerRunner = (storeUrl: string) => Promise<RunResult>;

export function companionJobs(
  store: LocalStore,
  client: CompanionClient,
  trainer: TrainerRunner,
  cloud: CloudData = new CloudData(client),
): Job[] {
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
    {
      // ML feature snapshots and labels (ADR 0118), with data asked of the cloud.
      name: 'features',
      everyMs: FEATURES_EVERY_MS,
      run: async () => {
        await syncMlMirror(store.sql, client);
        try {
          const pass = await runFeaturePass(store.sql, cloud);
          return {
            snapshots: pass.snapshots.length,
            labels: pass.labels,
            pendingSnapshots: pass.pendingSnapshots,
            pendingLabels: pass.pendingLabels,
          };
        } catch (error) {
          // Only the research producer's companion builds shared research data (O217).
          if (error instanceof CompanionApiError && error.code === 'not_producer') {
            return { skipped: 'not the research producer' };
          }
          throw error;
        }
      },
    },
    {
      // ML (ADR 0117): mirror the cloud's runs, train locally, push what is new.
      name: 'ml',
      everyMs: ML_EVERY_MS,
      run: async () => {
        const mirror = await syncMlMirror(store.sql, client);
        const trained = await trainer(store.url);
        if (trained.code !== 0) {
          throw new Error(`The trainer stopped: ${trained.tail.at(-1) ?? `exit ${trained.code}`}`);
        }
        let pushed;
        try {
          pushed = await pushMlOutputs(store.sql, client);
        } catch (error) {
          // Only the research producer's companion publishes (O216); others just train.
          if (error instanceof CompanionApiError && error.code === 'not_producer') {
            return { ...mirror, pushed: 'not the research producer' };
          }
          throw error;
        }
        const refused = await refusedPushes(client);
        return {
          ...mirror,
          pushed,
          refused: refused.length,
          ...(refused[0] ? { lastRefusal: `${refused[0].clientKey}: ${refused[0].error}` } : {}),
        };
      },
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
  /** Stand-in for the Python trainer (tests). */
  trainer?: TrainerRunner;
  /** How data requests to the cloud are polled (tests make it quick). */
  cloud?: Omit<CloudDataOptions, 'signal'>;
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
    const trainer: TrainerRunner =
      options.trainer ??
      (async (storeUrl) =>
        runTrainer({
          python: await ensurePython(options.home, options.log),
          storeUrl,
          log: options.log,
          signal: options.signal,
        }));
    const cloud = new CloudData(client, { ...options.cloud, signal: options.signal });
    return await runJobs(companionJobs(store, client, trainer, cloud), options.signal, {
      ...options.hooks,
      log: options.log,
      onResult: (job, outcome) => recordJob(store.sql, job, outcome),
    });
  } finally {
    await store.stop();
  }
}
