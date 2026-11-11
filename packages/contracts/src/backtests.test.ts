import { describe, expect, it } from 'vitest';
import { startBacktestRequest } from './backtests';
import { createApiClient } from './client';

describe('back-test requests', () => {
  it('fills omitted inputs with the proposed defaults', () => {
    expect(startBacktestRequest.parse({ from: '2024-01-02', to: '2024-12-31' })).toEqual({
      from: '2024-01-02',
      to: '2024-12-31',
      interval: '1d',
      initialCapital: '100000',
      adjustment: 'split_and_dividend',
      slippageBps: '5',
      commissionPerShare: '0',
      commissionMin: '0',
      maxVolumePct: '10',
      borrowRatePct: '1',
    });
  });

  it("checks the dates; the range limit waits for the strategy's bars (N233)", () => {
    expect(
      startBacktestRequest.safeParse({ from: '2022-01-03', to: '2024-01-03', interval: '1h' })
        .success,
    ).toBe(true);
    expect(startBacktestRequest.safeParse({ from: '2024-02-01', to: '2024-01-01' }).success).toBe(
      false,
    );
    expect(
      startBacktestRequest.safeParse({ from: '2024-01-02', to: '2024-02-01', symbols: ['aapl'] })
        .success,
    ).toBe(false);
    expect(startBacktestRequest.safeParse('nope').success).toBe(false);
  });

  it('calls the §14.2 routes', async () => {
    const calls: string[] = [];
    const api = createApiClient({
      fetch: (url, init) => {
        calls.push(`${init?.method} ${String(url)}`);
        return Promise.resolve(Response.json({}));
      },
    });
    await api.backtests.start('s1', { from: '2024-01-02', to: '2024-03-01' });
    await api.backtests.get('r1');
    await api.backtests.cancel('r1');
    await api.backtests.trades('r1');
    await api.backtests.list('s1');
    expect(calls).toEqual([
      'POST /api/v1/strategies/s1/backtests',
      'GET /api/v1/backtests/r1',
      'POST /api/v1/backtests/r1/cancel',
      'GET /api/v1/backtests/r1/trades',
      'GET /api/v1/strategies/s1/backtests',
    ]);
    expect(api.backtests.exportUrl('r1')).toBe('/api/v1/backtests/r1/export');
  });
});
