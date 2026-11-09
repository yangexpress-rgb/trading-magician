import type { BacktestMetrics } from '@tm/backtest';
import { describe, expect, it } from 'vitest';
import {
  intervalHint,
  describeRun,
  DIRECTION_WORDS,
  tradeDirection,
  formatMarketTime,
  formatPct,
  formatSignedMoney,
  linePath,
  atrStopText,
  sizingText,
  metricTiles,
  thin,
} from './backtest-text';

const metrics: BacktestMetrics = {
  initialCapital: '100000',
  finalEquity: '104250.5',
  netReturnPct: '4.25',
  grossReturnPct: '4.4',
  maxDrawdownPct: '3.1',
  winRatePct: '55.56',
  profitFactor: '1.8',
  sharpe: null,
  cycles: 9,
  closedCycles: 9,
  orders: 18,
  fills: 18,
  commission: '0',
  slippage: '140.2',
  borrow: '9.8',
  averageExposurePct: '12.5',
};

describe('back-test text', () => {
  it('signs returns and amounts in words, not only colour', () => {
    expect(formatPct('4.25', true)).toBe('+4.25%');
    expect(formatPct('-1.5', true)).toBe('−1.5%');
    expect(formatPct(null)).toBe('—');
    expect(formatSignedMoney('-22')).toBe('−$22.00');
    expect(formatSignedMoney('97.9')).toBe('+$97.90');
  });

  it('builds the §7.3 tiles', () => {
    const tiles = Object.fromEntries(metricTiles(metrics).map((t) => [t.label, t]));
    expect(tiles['Net return']).toEqual({
      label: 'Net return',
      value: '+4.25%',
      detail: '$100,000.00 → $104,250.50',
    });
    expect(tiles['Sharpe ratio']?.detail).toBe('Needs 20 trading days');
    expect(tiles['Costs']?.value).toBe('$150.00');
    expect(tiles['Cycles']?.detail).toBe('18 orders, 18 fills');
  });

  it('names the run and shows market times in New York', () => {
    expect(
      describeRun({
        versionNo: 2,
        inputs: { from: '2023-01-03', to: '2023-12-29', interval: '1d' } as never,
      }),
    ).toBe('Version 2 · Jan 3, 2023 to Dec 29, 2023 · Daily bars');
    expect(formatMarketTime('2023-01-03T14:30:00.000Z', '1d')).toBe('Jan 3, 2023');
    expect(formatMarketTime('2023-01-03T14:30:00.000Z', '1h')).toBe('Jan 3, 2023, 9:30 AM');
  });

  it('scales a line into the chart box', () => {
    const { path, min, max } = linePath([10, 20, 15], 100, 50);
    expect(min).toBe(10);
    expect(max).toBe(20);
    const ys = path
      .split(/[ML]/)
      .filter(Boolean)
      .map((p) => Number(p.trim().split(' ')[1]));
    expect(ys[0]).toBeGreaterThan(ys[1]!); // lower value sits lower on screen
    expect(path.startsWith('M0.0')).toBe(true);
    expect(path).toContain('L100.0');
    expect(linePath([5, 5], 10, 10).path).not.toContain('NaN');
  });

  it('thins long series but keeps both ends', () => {
    const t = thin(
      Array.from({ length: 2000 }, (_, i) => i),
      100,
    );
    expect(t).toHaveLength(100);
    expect(t[0]).toBe(0);
    expect(t.at(-1)).toBe(1999);
  });
});

describe('risk sizing and ATR stop text (v1.2 item 9)', () => {
  const sizing = {
    method: 'risk_atr' as const,
    equity: '100000',
    riskPct: '1',
    atrPeriod: 20,
    atr: '4.1234',
    atrMultiple: '2',
    stopDistance: '8.2468',
    riskQuantity: '121',
    quantity: '121',
  };

  it('shows each step, so the quantity checks by hand', () => {
    expect(sizingText(sizing)).toEqual([
      'Risk 1% of $100,000.00 equity = $1,000.00',
      'Stop distance 8.2468 = 2 × ATR(20) 4.1234',
      '$1,000.00 ÷ 8.2468 = 121 shares',
    ]);
    expect(sizingText({ ...sizing, quantity: '25', cappedBy: 'max_order_size' })[3]).toBe(
      'Capped at 25 by the maximum order size',
    );
  });

  it('shows the fixed stop level for longs and shorts', () => {
    const stop = { atr: '4.1234', atrMultiple: '2', entryPrice: '400', level: '391.7532' };
    expect(atrStopText({ ...stop, direction: 'long' })).toBe(
      'Stop 391.7532 = entry 400 − 2 × ATR 4.1234',
    );
    expect(atrStopText({ ...stop, direction: 'short', level: '408.2468' })).toBe(
      'Stop 408.2468 = entry 400 + 2 × ATR 4.1234',
    );
  });
});

describe('tradeDirection', () => {
  const leg = (phase: string, side: string) => ({ phase, side });
  it('calls a pair long and short, whatever its group says', () => {
    expect(
      tradeDirection({
        direction: 'long',
        legs: [leg('entry', 'buy'), leg('entry', 'sell_short'), leg('exit', 'sell')],
      }),
    ).toBe('long_short');
    expect(DIRECTION_WORDS.long_short).toBe('Long and short');
  });
  it('reads all-short and all-long Entry legs, and the record without fills', () => {
    expect(tradeDirection({ legs: [leg('entry', 'sell_short')] })).toBe('short');
    expect(tradeDirection({ direction: 'short', legs: [leg('entry', 'buy')] })).toBe('long');
    expect(tradeDirection({ direction: 'short', legs: [] })).toBe('short');
    expect(tradeDirection({ legs: [] })).toBe('long');
  });
});

describe('intervalHint (N179)', () => {
  it('says when the bars match the conditions and when they are coarser', () => {
    expect(intervalHint('5m', '5m')).toMatch(
      /^Matches your conditions, which check every 5 minutes\./,
    );
    expect(intervalHint('1h', '5m')).toMatch(
      /^Your conditions check every 5 minutes, so hourly bars check them less often/,
    );
    expect(intervalHint('1d', undefined)).toBe(
      'Up to 5 years daily, 1 year hourly or 31 days of 5-minute bars.',
    );
  });

  it('names 5-minute runs', () => {
    expect(
      describeRun({
        versionNo: 2,
        inputs: { from: '2025-03-03', to: '2025-03-31', interval: '5m' },
      } as never),
    ).toBe('Version 2 · Mar 3, 2025 to Mar 31, 2025 · 5-minute bars');
  });
});
