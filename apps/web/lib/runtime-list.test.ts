import type { RuntimeSummaryDto } from '@tm/contracts';
import { describe, expect, it } from 'vitest';
import {
  countRuntimeFilters,
  emptyRuntimeFilters,
  matchesRuntime,
  parseBound,
  parseRuntimeView,
  winRate,
  type RuntimeListFilters,
} from './runtime-list';

const NOW = Date.parse('2026-11-19T15:00:00Z');
const DAY = 86_400_000;

function run(over: Partial<RuntimeSummaryDto> = {}): RuntimeSummaryDto {
  return {
    id: 'r1',
    strategyId: 's1',
    strategyName: 'VIX fear-buy SPY',
    strategyNumber: 'S00041-ED',
    status: 'running',
    pauseReason: null,
    accountId: 'a1',
    accountName: 'Alpaca paper ••••4BD4',
    accountMode: 'paper',
    startedAt: new Date(NOW - 2 * DAY).toISOString(),
    stoppedAt: null,
    workingOrders: 0,
    cycles: { completed: 4, active: 1, rejected: 2, entering: 0 },
    realizedPnl: '125.50',
    wins: 3,
    lastEntryAt: new Date(NOW - DAY / 2).toISOString(),
    ...over,
  };
}

const filters = (over: Partial<RuntimeListFilters> = {}): RuntimeListFilters => ({
  ...emptyRuntimeFilters(),
  ...over,
});

const ranges = (key: keyof RuntimeListFilters['ranges'], min: string, max: string) => ({
  ...emptyRuntimeFilters().ranges,
  [key]: { min, max },
});

describe('Strategies on paper list (N304)', () => {
  it('opens as a list unless the cards were chosen', () => {
    expect(parseRuntimeView(null)).toBe('list');
    expect(parseRuntimeView('cards')).toBe('cards');
    expect(parseRuntimeView('junk')).toBe('list');
  });

  it('keeps every run with no filter set', () => {
    expect(countRuntimeFilters(filters())).toBe(0);
    expect(matchesRuntime(run(), filters(), NOW)).toBe(true);
  });

  it('filters by number and name text, ignoring case', () => {
    expect(matchesRuntime(run(), filters({ number: 's00041' }), NOW)).toBe(true);
    expect(matchesRuntime(run(), filters({ number: 'S00042' }), NOW)).toBe(false);
    expect(matchesRuntime(run({ strategyNumber: null }), filters({ number: 'S' }), NOW)).toBe(
      false,
    );
    expect(matchesRuntime(run(), filters({ strategy: 'fear' }), NOW)).toBe(true);
    expect(matchesRuntime(run(), filters({ strategy: 'calm' }), NOW)).toBe(false);
  });

  it('filters by status and by when it started or last entered', () => {
    expect(matchesRuntime(run(), filters({ status: 'paused' }), NOW)).toBe(false);
    expect(matchesRuntime(run({ status: 'paused' }), filters({ status: 'paused' }), NOW)).toBe(
      true,
    );
    expect(matchesRuntime(run(), filters({ started: '1d' }), NOW)).toBe(false);
    expect(matchesRuntime(run(), filters({ started: '7d' }), NOW)).toBe(true);
    expect(matchesRuntime(run(), filters({ started: 'older' }), NOW)).toBe(false);
    expect(matchesRuntime(run(), filters({ lastEntry: '1d' }), NOW)).toBe(true);
    expect(matchesRuntime(run(), filters({ lastEntry: 'none' }), NOW)).toBe(false);
    expect(matchesRuntime(run({ lastEntryAt: null }), filters({ lastEntry: 'none' }), NOW)).toBe(
      true,
    );
    expect(matchesRuntime(run({ lastEntryAt: null }), filters({ lastEntry: '30d' }), NOW)).toBe(
      false,
    );
  });

  it('filters numbers by at least / at most, reading $ and %', () => {
    expect(matchesRuntime(run(), filters({ ranges: ranges('rejected', '1', '') }), NOW)).toBe(true);
    expect(matchesRuntime(run(), filters({ ranges: ranges('rejected', '', '1') }), NOW)).toBe(
      false,
    );
    expect(matchesRuntime(run(), filters({ ranges: ranges('pnl', '$100', '') }), NOW)).toBe(true);
    expect(matchesRuntime(run(), filters({ ranges: ranges('pnl', '', '−1') }), NOW)).toBe(false);
    expect(matchesRuntime(run(), filters({ ranges: ranges('winRate', '75%', '') }), NOW)).toBe(
      true,
    );
    expect(matchesRuntime(run(), filters({ ranges: ranges('winRate', '80', '') }), NOW)).toBe(
      false,
    );
    expect(countRuntimeFilters(filters({ ranges: ranges('pnl', '1', '') }))).toBe(1);
  });

  it('leaves out runs with no win rate when the win rate is filtered', () => {
    const fresh = run({ cycles: { completed: 0, active: 0, rejected: 0, entering: 0 }, wins: 0 });
    expect(winRate(fresh)).toBeNull();
    expect(matchesRuntime(fresh, filters({ ranges: ranges('winRate', '0', '') }), NOW)).toBe(false);
  });

  it('ignores a bound it cannot read yet', () => {
    expect(parseBound('-')).toBeNull();
    expect(parseBound('')).toBeUndefined();
    expect(parseBound('$1,200')).toBe(1200);
    expect(matchesRuntime(run(), filters({ ranges: ranges('pnl', '-', '') }), NOW)).toBe(true);
  });
});
