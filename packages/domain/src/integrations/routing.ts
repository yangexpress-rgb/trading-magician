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

/** What to do when the feed pricing an account stops (Phase 7 P2, ADR 0108). */
export type FeedFailureMode = 'fallback' | 'pause';

/** A paper account moves to its next feed; a live one pauses and tells the person. */
export function feedFailureMode(
  setting: FeedFailureMode | null,
  accountMode: 'paper' | 'live',
): FeedFailureMode {
  return setting ?? (accountMode === 'live' ? 'pause' : 'fallback');
}

export type ChainStep =
  | { kind: 'stay' }
  /** Move to another feed in the chain: a fallback, or back to the primary. */
  | { kind: 'switch'; to: string; back: boolean }
  /** The feed is down and the account's runs pause instead of switching. */
  | { kind: 'pause' }
  /** The feed answers again after a pause. */
  | { kind: 'recovered' }
  | { kind: 'primary_recovering'; since: string }
  | { kind: 'primary_relapsed' };

/**
 * One look at an account's feed chain (ADR 0108): the feeds in order (the
 * first is the primary), the one pricing it now, and which of them answer.
 * Pure, like `failoverStep`, so the worker and its tests agree on every edge.
 *
 * - The feed pricing it stops: in pause mode the account pauses; otherwise it
 *   moves to the first feed after it that answers (then from the top), or
 *   stays if none does.
 * - On a fallback, the primary must look healthy for `FAILOVER.recoverAfterMs`
 *   before prices move back to it.
 */
export function chainStep(input: {
  chain: readonly string[];
  active: string | null;
  primaryOkSince: string | null;
  mode: FeedFailureMode;
  /** True while the account is paused for this chain's feed. */
  pausedForFeed: boolean;
  healthy: (feedId: string) => boolean;
  now: Date;
}): ChainStep {
  const { chain, mode, healthy, now } = input;
  const primary = chain[0];
  if (!primary) return { kind: 'stay' };
  // No feed recorded (or one no longer in the chain) means the primary.
  const active = input.active && chain.includes(input.active) ? input.active : primary;
  if (!healthy(active)) {
    // Every look while it is down, so a run resumed meanwhile pauses again.
    if (mode === 'pause') return { kind: 'pause' };
    const from = chain.indexOf(active);
    const order = [...chain.slice(from + 1), ...chain.slice(0, from)];
    const next = order.find((id) => healthy(id));
    return next ? { kind: 'switch', to: next, back: next === primary } : { kind: 'stay' };
  }
  if (input.pausedForFeed) return { kind: 'recovered' };
  if (active === primary) return { kind: 'stay' };
  if (!healthy(primary)) {
    return input.primaryOkSince ? { kind: 'primary_relapsed' } : { kind: 'stay' };
  }
  if (!input.primaryOkSince) return { kind: 'primary_recovering', since: now.toISOString() };
  return now.getTime() - Date.parse(input.primaryOkSince) >= FAILOVER.recoverAfterMs
    ? { kind: 'switch', to: primary, back: true }
    : { kind: 'stay' };
}
