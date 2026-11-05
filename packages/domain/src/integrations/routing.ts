/**
 * Market-data routing (§9.2, ADR 0016): each route maps an asset class, an
 * optional venue and a data type to one primary feed and an optional
 * fallback. Selection is deterministic: a route for the exact venue wins over
 * the any-venue route for the same asset class and data type.
 */

export type RouteDataType = 'quotes' | 'trades' | 'bars';
export type RouteSource = 'primary' | 'fallback';

export interface RouteLike {
  id: string;
  assetClass: string;
  venue: string | null;
  dataType: RouteDataType;
  primaryFeedId: string;
  fallbackFeedId: string | null;
  activeSource: RouteSource;
  primaryOkSince: string | null;
}

export interface RouteTarget {
  assetClass: string;
  venue: string;
  dataType: RouteDataType;
}

export function resolveRoute<R extends RouteLike>(routes: readonly R[], target: RouteTarget) {
  const same = routes.filter(
    (r) => r.assetClass === target.assetClass && r.dataType === target.dataType,
  );
  return same.find((r) => r.venue === target.venue) ?? same.find((r) => r.venue === null);
}

/** Failover defaults; confirmed with the Phase 4 plan (2026-10-04). */
export const FAILOVER = {
  /** A primary quote older than this, or none at all, counts as down. */
  staleSec: 60,
  /** How long the primary must look healthy again before prices switch back. */
  recoverAfterMs: 5 * 60_000,
} as const;

export type FailoverStep =
  | { kind: 'stay' }
  | { kind: 'fail_over' }
  | { kind: 'primary_recovering'; since: string }
  | { kind: 'primary_relapsed' }
  | { kind: 'switch_back' };

/**
 * What a route should do after one look at its primary feed. Pure, so the
 * runtime and its tests agree on every edge.
 */
export function failoverStep(
  route: Pick<RouteLike, 'activeSource' | 'fallbackFeedId' | 'primaryOkSince'>,
  primaryHealthy: boolean,
  now: Date,
): FailoverStep {
  if (route.activeSource === 'primary') {
    return !primaryHealthy && route.fallbackFeedId ? { kind: 'fail_over' } : { kind: 'stay' };
  }
  if (!primaryHealthy) {
    return route.primaryOkSince ? { kind: 'primary_relapsed' } : { kind: 'stay' };
  }
  if (!route.primaryOkSince) return { kind: 'primary_recovering', since: now.toISOString() };
  return now.getTime() - Date.parse(route.primaryOkSince) >= FAILOVER.recoverAfterMs
    ? { kind: 'switch_back' }
    : { kind: 'stay' };
}
