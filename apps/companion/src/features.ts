import { runSnapshotPass, schema, type Database, type SnapshotPassResult } from '@tm/db';
import { drizzle } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import type { CloudData } from './cloud-data';

/**
 * The ML feature writer on the companion (ADR 0118, S2 step 3b): the cloud's
 * own snapshot job, run against the local store. The model registry is the
 * local mirror (ADR 0117); snapshots, labels and the availability report are
 * written locally; members, instruments, bars, filings and earnings are asked
 * of the cloud. A date the cloud already served is frozen in the mirror, so
 * the job never writes it here either: those dates arrive with the data move.
 */

export interface FeaturePassOptions {
  /** Chunks of prediction dates per pass (each loads every member's bars once). */
  maxChunks?: number;
  now?: () => Date;
  log?: (line: string) => void;
}

export function localDatabase(sql: postgres.Sql): Database {
  return drizzle(sql, { schema }) as unknown as Database;
}

export async function runFeaturePass(
  sql: postgres.Sql,
  cloud: CloudData,
  options: FeaturePassOptions = {},
): Promise<SnapshotPassResult> {
  const db = localDatabase(sql);
  const log = options.log ?? (() => undefined);
  return runSnapshotPass({
    db,
    research: db,
    history: cloud.history(),
    fundamentals: cloud.filings,
    members: (universe) => cloud.members(universe),
    refs: (ids) => cloud.instrumentRefs(ids),
    events: (reads) => cloud.events(reads),
    prefetchBars: true,
    // The cloud answers through the person's own feeds; the id is not sent.
    userId: '',
    now: options.now ?? (() => new Date()),
    maxChunks: options.maxChunks ?? 1,
    logger: {
      info: (obj, msg) => log(`${msg} ${JSON.stringify(obj)}`),
      warn: (obj, msg) => log(`${msg} ${JSON.stringify(obj)}`),
    },
  });
}
