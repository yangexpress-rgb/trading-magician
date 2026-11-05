import { describe, expect, it } from 'vitest';
import { failoverStep, FAILOVER, resolveRoute, type RouteLike } from './routing';

const route = (over: Partial<RouteLike>): RouteLike => ({
  id: 'r',
  assetClass: 'stock',
  venue: null,
  dataType: 'quotes',
  primaryFeedId: 'p',
  fallbackFeedId: 'f',
  activeSource: 'primary',
  primaryOkSince: null,
  ...over,
});

describe('resolveRoute', () => {
  const routes = [
    route({ id: 'any-stock' }),
    route({ id: 'xnas-stock', venue: 'XNAS' }),
    route({ id: 'any-etf', assetClass: 'etf' }),
    route({ id: 'stock-bars', dataType: 'bars' }),
  ];

  it('prefers the exact venue, then the any-venue route', () => {
    expect(
      resolveRoute(routes, { assetClass: 'stock', venue: 'XNAS', dataType: 'quotes' })?.id,
    ).toBe('xnas-stock');
    expect(
      resolveRoute(routes, { assetClass: 'stock', venue: 'XNYS', dataType: 'quotes' })?.id,
    ).toBe('any-stock');
    expect(resolveRoute(routes, { assetClass: 'stock', venue: 'XNYS', dataType: 'bars' })?.id).toBe(
      'stock-bars',
    );
    expect(resolveRoute(routes, { assetClass: 'crypto', venue: 'X', dataType: 'quotes' })).toBe(
      undefined,
    );
  });
});

describe('failoverStep', () => {
  const now = new Date('2026-10-06T15:00:00Z');
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

  it('fails over only when there is a fallback', () => {
    expect(failoverStep(route({}), false, now)).toEqual({ kind: 'fail_over' });
    expect(failoverStep(route({ fallbackFeedId: null }), false, now)).toEqual({ kind: 'stay' });
    expect(failoverStep(route({}), true, now)).toEqual({ kind: 'stay' });
  });

  it('switches back only after the primary stays healthy long enough', () => {
    const onFallback = route({ activeSource: 'fallback' });
    expect(failoverStep(onFallback, true, now)).toEqual({
      kind: 'primary_recovering',
      since: now.toISOString(),
    });
    const recovering = route({ activeSource: 'fallback', primaryOkSince: ago(60_000) });
    expect(failoverStep(recovering, true, now)).toEqual({ kind: 'stay' });
    expect(failoverStep(recovering, false, now)).toEqual({ kind: 'primary_relapsed' });
    const recovered = route({
      activeSource: 'fallback',
      primaryOkSince: ago(FAILOVER.recoverAfterMs),
    });
    expect(failoverStep(recovered, true, now)).toEqual({ kind: 'switch_back' });
    expect(failoverStep(onFallback, false, now)).toEqual({ kind: 'stay' });
  });
});
