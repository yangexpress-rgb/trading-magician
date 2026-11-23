import { describe, expect, it } from 'vitest';
import {
  chainStep,
  failoverStep,
  feedFailureMode,
  FAILOVER,
  resolveRoute,
  type RouteLike,
} from './routing';

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

describe("chainStep (an account's own feeds, ADR 0108)", () => {
  const now = new Date('2026-11-23T15:00:00Z');
  const step = (over: Partial<Parameters<typeof chainStep>[0]> & { down?: string[] }) =>
    chainStep({
      chain: ['a', 'b', 'c'],
      active: null,
      primaryOkSince: null,
      mode: 'fallback',
      pausedForFeed: false,
      now,
      healthy: (id) => !(over.down ?? []).includes(id),
      ...over,
    });

  it('stays on a healthy primary, and with no chain', () => {
    expect(step({})).toEqual({ kind: 'stay' });
    expect(step({ chain: [] })).toEqual({ kind: 'stay' });
  });

  it('moves to the next feed that answers when the one pricing it stops', () => {
    expect(step({ down: ['a'] })).toEqual({ kind: 'switch', to: 'b', back: false });
    expect(step({ down: ['a', 'b'] })).toEqual({ kind: 'switch', to: 'c', back: false });
    expect(step({ active: 'b', down: ['a', 'b'] })).toEqual({
      kind: 'switch',
      to: 'c',
      back: false,
    });
    expect(step({ active: 'c', down: ['b', 'c'] })).toEqual({
      kind: 'switch',
      to: 'a',
      back: true,
    });
    expect(step({ down: ['a', 'b', 'c'] })).toEqual({ kind: 'stay' });
  });

  it('pauses instead in pause mode, and says when the feed answers again', () => {
    expect(step({ mode: 'pause', down: ['a'] })).toEqual({ kind: 'pause' });
    expect(step({ mode: 'pause', down: ['a'], pausedForFeed: true })).toEqual({ kind: 'pause' });
    expect(step({ mode: 'pause', pausedForFeed: true })).toEqual({ kind: 'recovered' });
  });

  it('moves back to the primary only after it has looked healthy for five minutes', () => {
    expect(step({ active: 'b' })).toEqual({ kind: 'primary_recovering', since: now.toISOString() });
    const since = new Date(now.getTime() - FAILOVER.recoverAfterMs + 1000).toISOString();
    expect(step({ active: 'b', primaryOkSince: since })).toEqual({ kind: 'stay' });
    const long = new Date(now.getTime() - FAILOVER.recoverAfterMs).toISOString();
    expect(step({ active: 'b', primaryOkSince: long })).toEqual({
      kind: 'switch',
      to: 'a',
      back: true,
    });
    expect(step({ active: 'b', primaryOkSince: since, down: ['a'] })).toEqual({
      kind: 'primary_relapsed',
    });
    expect(step({ active: 'b', down: ['a'] })).toEqual({ kind: 'stay' });
  });

  it('treats a feed no longer in the chain as the primary', () => {
    expect(step({ active: 'gone' })).toEqual({ kind: 'stay' });
  });

  it('defaults to the fallback on paper and to pausing on a live account', () => {
    expect(feedFailureMode(null, 'paper')).toBe('fallback');
    expect(feedFailureMode(null, 'live')).toBe('pause');
    expect(feedFailureMode('pause', 'paper')).toBe('pause');
  });
});
