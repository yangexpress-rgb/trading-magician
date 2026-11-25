/**
 * The ML feature snapshot job lives in `@tm/db` (ADR 0118), so the Local
 * Companion runs the same code; the worker's loop imports it from here.
 */
export {
  featureSeries,
  LABEL_RETRY_DAYS,
  runSnapshotPass,
  type SnapshotJobOptions,
  type SnapshotPassResult,
} from '@tm/db';
