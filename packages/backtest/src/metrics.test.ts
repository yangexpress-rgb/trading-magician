import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { computeMetrics, dailyCloses, maxDrawdown, sharpe } from './metrics';
import type { BacktestTrade, EquityPoint } from './results';

const d = (values: number[]) => values.map((v) => new Decimal(v));
const point = (time: string, equity: string, grossExposure = '0'): EquityPoint => ({
  time,
  equity,
  cash: equity,
  grossExposure,
  netExposure: grossExposure,
});
const trade = (netPnl: string, status: BacktestTrade['status'] = 'closed'): BacktestTrade => ({
  cycle: 1,
  status,
  entryTime: null,
  exitTime: null,
  legs: [],
  grossPnl: netPnl,
  costs: '0',
  netPnl,
  returnPct: null,
});

describe('metrics', () => {
  it('measures the largest fall from a peak', () => {
    expect(maxDrawdown(d([110, 99, 120, 90, 130]), new Decimal(100)).toString()).toBe('0.25');
    expect(maxDrawdown(d([101, 102]), new Decimal(100)).toString()).toBe('0');
  });

  it('needs 20 days for a Sharpe ratio', () => {
    expect(sharpe(d(Array.from({ length: 19 }, (_, i) => 100 + i)), new Decimal(100))).toBeNull();
    // Alternating +1% / −0.5%: mean 0.25%, sample stdev ≈ 0.77%.
    const closes: number[] = [];
    let v = 100;
    for (let i = 0; i < 20; i++) closes.push((v *= i % 2 === 0 ? 1.01 : 0.995));
    const s = sharpe(d(closes), new Decimal(100));
    const r = closes.map((c, i) => c / (i === 0 ? 100 : (closes[i - 1] ?? 1)) - 1);
    const mean = r.reduce((a, x) => a + x, 0) / r.length;
    const sd = Math.sqrt(r.reduce((a, x) => a + (x - mean) ** 2, 0) / (r.length - 1));
    expect(Number(s)).toBeCloseTo((mean / sd) * Math.sqrt(252), 6);
  });

  it('takes the last point of each New York day', () => {
    const closes = dailyCloses([
      point('2024-03-04T15:30:00Z', '100'),
      point('2024-03-04T21:00:00Z', '101'),
      point('2024-03-05T21:00:00Z', '102'),
    ]);
    expect(closes.map(String)).toEqual(['101', '102']);
  });

  it('summarises trades, costs and exposure', () => {
    const m = computeMetrics({
      initial: new Decimal(1000),
      equity: [
        point('2024-03-04T21:00:00Z', '1000', '500'),
        point('2024-03-05T21:00:00Z', '1050', '0'),
      ],
      trades: [trade('80'), trade('-20'), trade('-10'), trade('5', 'open'), trade('0', 'aborted')],
      orders: 9,
      fills: 8,
      commission: new Decimal(3),
      slippage: new Decimal(2),
      borrow: new Decimal(1),
    });
    expect(m).toEqual({
      initialCapital: '1000',
      finalEquity: '1050',
      netReturnPct: '5',
      grossReturnPct: '5.6',
      maxDrawdownPct: '0',
      winRatePct: '33.33',
      profitFactor: '2.67',
      sharpe: null,
      cycles: 4,
      closedCycles: 3,
      orders: 9,
      fills: 8,
      commission: '3',
      slippage: '2',
      borrow: '1',
      averageExposurePct: '25',
    });
  });
});
