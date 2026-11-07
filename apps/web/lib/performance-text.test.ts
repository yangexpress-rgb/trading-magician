import type { PerformanceSummaryDto } from '@tm/contracts';
import { describe, expect, it } from 'vitest';
import {
  assetChoices,
  describePositionDifference,
  performanceSearch,
  performanceTiles,
} from './performance-text';

const summary = (over: Partial<PerformanceSummaryDto> = {}): PerformanceSummaryDto => ({
  currency: 'USD',
  from: null,
  to: null,
  filtered: false,
  equity: {
    start: '100000.00',
    end: '100150.00',
    returnPct: '0.15',
    maxDrawdownPct: '0.15',
    sharpe: null,
    brokerEnd: null,
  },
  sessions: 3,
  shortHistory: true,
  pnl: { net: '150.00', gross: '150.00', realized: '200.00', unrealized: '-50.00', fees: '0.00' },
  exposure: { gross: '950.00', pctOfEquity: '0.95' },
  turnover: { traded: '4950.00', pctOfEquity: '4.94' },
  peakCapital: '2000.00',
  returnOnPeakCapitalPct: '7.50',
  trades: {
    count: 2,
    open: 1,
    closed: 1,
    wins: 1,
    losses: 0,
    winRatePct: '100.00',
    profitFactor: null,
    averageNet: '200.00',
    averageWin: '200.00',
    averageLoss: null,
    best: '200.00',
    worst: '200.00',
  },
  byStrategy: [],
  byAsset: [],
  assetClasses: ['stock'],
  dataQuality: { lastValuedAt: null, staleMarks: 0, differences: [] },
  ...over,
});

describe('performanceTiles', () => {
  it('shows account return and drawdown, noting a short history', () => {
    const tiles = performanceTiles(summary());
    expect(tiles.find((t) => t.label === 'Return')?.value).toBe('+0.15%');
    expect(tiles.find((t) => t.label === 'Max drawdown')).toEqual({
      label: 'Max drawdown',
      value: '0.15%',
      detail: 'Fewer than 20 sessions',
    });
    expect(tiles.find((t) => t.label === 'Net P/L')?.value).toBe('+$150.00');
    expect(tiles.find((t) => t.label === 'Average gain / loss')?.value).toBe('+$200.00 / —');
    expect(tiles.find((t) => t.label === 'Sharpe ratio')?.detail).toBe('Needs 20 sessions');
  });

  it('shows return on peak capital instead when the view is filtered', () => {
    const labels = performanceTiles(summary({ filtered: true })).map((t) => t.label);
    expect(labels).toContain('Return on peak capital');
    expect(labels).not.toContain('Return');
    expect(labels).not.toContain('Sharpe ratio');
  });
});

describe('equity tile', () => {
  const equity = (brokerEnd: string | null) =>
    performanceTiles(
      summary({
        equity: {
          start: '100000.00',
          end: '100150.00',
          returnPct: '0.15',
          maxDrawdownPct: '0.15',
          sharpe: null,
          brokerEnd,
        },
      }),
    ).find((t) => t.label === 'Equity');

  it("shows the broker's figure where it differs, since it counts", () => {
    expect(equity('100210.00')).toEqual({
      label: 'Equity',
      value: '$100,210.00',
      detail: "Broker's figure; the app works out $100,150.00",
    });
    expect(equity('100150.50')?.detail).toBe('The broker and the app agree');
    expect(equity(null)).toEqual({
      label: 'Equity',
      value: '$100,150.00',
      detail: "From the app's ledger",
    });
  });
});

describe('performanceSearch', () => {
  it('keeps set filters and leaves out the paper default', () => {
    expect(performanceSearch({ mode: 'paper' })).toBe('');
    expect(performanceSearch({ mode: 'live', accountId: 'a', from: '2026-10-01' })).toBe(
      '?from=2026-10-01&account=a&mode=live',
    );
  });
});

describe('describePositionDifference', () => {
  it('says which side holds what and how much is outside the app', () => {
    expect(describePositionDifference({ symbol: 'ZTSTA', app: '3', broker: '5' })).toBe(
      'ZTSTA: the app counts 3, the broker holds 5 (2 outside the app)',
    );
    expect(describePositionDifference({ symbol: 'ZTSTB', app: '0', broker: '3' })).toBe(
      'ZTSTB: the broker holds 3, all outside the app',
    );
    expect(describePositionDifference({ symbol: 'ZTSTX', app: '4', broker: '0' })).toBe(
      'ZTSTX: the app counts 4, the broker holds none',
    );
  });
});

describe('asset class filter choices (v1.2 item 10)', () => {
  it('offers only what was traded, from the instrument store, plus the current choice', () => {
    expect(assetChoices(['stock', 'etf'], undefined)).toEqual(['etf', 'stock']);
    expect(assetChoices(['stock'], 'etf')).toEqual(['etf', 'stock']);
    expect(assetChoices([], undefined)).toEqual([]);
    expect(assetChoices(undefined, undefined)).toEqual([]);
    // Indices are watched, never traded, so they are no choice here.
    expect(assetChoices(['index', 'stock'], undefined)).toEqual(['stock']);
  });
});
