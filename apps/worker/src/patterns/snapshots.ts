/**
 * The pattern factor snapshot job lives in `@tm/db` (ADR 0119), so the Local
 * Companion runs the same code; the worker's loop imports it from here.
 */
export {
  lastSnapshotDay,
  runPatternSnapshotPass,
  type PatternSnapshotOptions,
  type PatternSnapshotResult,
} from '@tm/db';
