import { addDays, nyDate, regularSession } from '../market/calendar';

/**
 * Machine-learning prediction signals (ML brief v1, ADR 0086). A model series
 * is trained outside the app, walk-forward, and its scores are stored once
 * per member per prediction date. Strategies read the stored scores through
 * the `ml.score` metric, the way they read options signals: no model ever
 * runs inside a back test or a paper runtime.
 */

/** A stored score older than this many calendar days reads as unknown (brief §8). */
export const ML_SCORE_MAX_AGE_DAYS = 45;

/** Model series keys: lower-case words joined by hyphens, e.g. `mf-ranker-ridge`. */
export const ML_MODEL_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const isMlModelKey = (key: unknown): key is string =>
  typeof key === 'string' && key.length <= 64 && ML_MODEL_KEY_PATTERN.test(key);

/** One stored prediction, as the engine reads it: the score and the run that made it. */
export interface MlPrediction {
  /** The prediction date (YYYY-MM-DD): features as of that day's close. */
  asOf: string;
  /** The model's raw output; higher is more attractive. */
  score: number;
  /** The model run's number within its series, from 1. */
  runNo: number;
  /** The last date whose features the run trained on (YYYY-MM-DD). */
  trainingEnd: string;
}

/** Predictions by model key, then by instrument id, each list sorted by `asOf`. */
export type MlPredictionData = ReadonlyMap<string, ReadonlyMap<string, readonly MlPrediction[]>>;

/** The first instant a prediction can be read: its date's regular close, like options signals. */
export function predictionAvailableFrom(asOf: string): number {
  const session = regularSession(asOf);
  return Date.parse(session?.close ?? `${asOf}T21:00:00Z`);
}

/**
 * The prediction visible at `atMs` (brief §8): the latest whose date has
 * closed by then, and no more than 45 calendar days old. Older reads as
 * unknown. `list` is sorted by `asOf`.
 */
export function predictionAt(
  list: readonly MlPrediction[] | undefined,
  atMs: number,
): MlPrediction | undefined {
  if (!list || list.length === 0) return undefined;
  let lo = 0;
  let hi = list.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (predictionAvailableFrom((list[mid] as MlPrediction).asOf) <= atMs) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  const p = found >= 0 ? list[found] : undefined;
  if (!p) return undefined;
  if (addDays(p.asOf, ML_SCORE_MAX_AGE_DAYS) < nyDate(new Date(atMs))) return undefined;
  return p;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Sep 30, 2026" from "2026-09-30". */
export function mlDateWords(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

/**
 * The provenance line the cycle card shows for an `ml.score` read (brief
 * §10), e.g. "ML score 0.83 — model mf-ranker-ridge, run 14, trained through
 * Aug 29, 2026, score dated Sep 30, 2026".
 */
export function mlProvenance(modelKey: string, p: MlPrediction, digits = 4): string {
  const score = Number(p.score.toFixed(digits));
  return `ML score ${score} — model ${modelKey}, run ${p.runNo}, trained through ${mlDateWords(p.trainingEnd)}, score dated ${mlDateWords(p.asOf)}`;
}
