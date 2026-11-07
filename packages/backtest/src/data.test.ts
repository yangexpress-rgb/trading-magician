import { BrokerUnavailableError, type HistoricalDataProvider } from '@tm/domain';
import { createDemoHistoryProvider } from '@tm/market-data';
import { describe, expect, it } from 'vitest';
import { BarLoadError, loadData, planSeries } from './data';
import { A, B, INSTRUMENTS, close, compare, inputs, leg, strategy } from './test-utils';

/** v1.2 review: one member's bars failing must not sink an S&P 500 back test. */
const demo = createDemoHistoryProvider({ now: () => new Date('2026-10-02T21:00:00Z') });
const failingFor = (symbol: string, error: Error): HistoricalDataProvider => ({
  ...demo,
  getBars: (req) => (req.symbol === symbol ? Promise.reject(error) : demo.getBars(req)),
});
const def = strategy(
  compare(close(A), 'gt', close(B)),
  [leg('buy')],
  compare(close(A), 'lt', close(B)),
  [leg('sell', { side: 'close' })],
);
const plans = planSeries(def, inputs('2023-01-03', '2023-03-31'));
const symbolB = INSTRUMENTS.get(B)!.symbol;

describe('loadData failures', () => {
  it('leaves out an optional member whose bars fail, and says why', async () => {
    const provider = failingFor(symbolB, new BrokerUnavailableError('Alpaca is not reachable'));
    const data = await loadData(provider, plans, INSTRUMENTS, undefined, new Set([B]));
    expect([...data.series.keys()].some((k) => k.startsWith(`${B}|`))).toBe(false);
    expect(data.warnings).toContainEqual(
      `1 member was left out because its bars could not be loaded: ${symbolB} (Alpaca is not reachable)`,
    );
  });

  it('stops on any other instrument, naming it and the reason', async () => {
    const provider = failingFor(symbolB, new BrokerUnavailableError('Alpaca is not reachable'));
    await expect(loadData(provider, plans, INSTRUMENTS)).rejects.toThrow(
      new BarLoadError(symbolB, new BrokerUnavailableError('Alpaca is not reachable')),
    );
  });

  it('never repeats the text of an unexpected error', async () => {
    const provider = failingFor(symbolB, new Error('password=hunter2'));
    const error = await loadData(provider, plans, INSTRUMENTS).catch((e: unknown) => e);
    expect((error as Error).message).toBe(
      `Bars for ${symbolB} could not be loaded: the data feed failed unexpectedly`,
    );
  });
});
