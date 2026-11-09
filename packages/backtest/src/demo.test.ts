import type { IndicatorExpr } from '@tm/domain';
import { createDemoHistoryProvider, DEMO_HISTORY_VERSION } from '@tm/market-data';
import { describe, expect, it } from 'vitest';
import { loadData, planSeries } from './data';
import { simulate } from './engine';
import { backtestInputsSchema } from './inputs';
import { A, B, INSTRUMENTS, close, compare, inputs, leg, strategy } from './test-utils';

const provider = createDemoHistoryProvider({ now: () => new Date('2026-10-02T21:00:00Z') });

const sma = (period: number): IndicatorExpr => ({
  kind: 'indicator',
  id: `sma-${period}`,
  name: 'SMA',
  params: { period },
  instrumentId: A,
  field: 'close',
  interval: '1d',
  adjustment: 'split_and_dividend',
  session: 'regular',
  offset: 0,
});

/** Long DEMO-A, short DEMO-B while A trades above its 20-day average. */
const pair = () => {
  const def = strategy(
    compare(close(A), 'crosses_above', sma(20)),
    [
      leg('long-a', { quantity: { type: 'notional', value: '5000', rounding: 'down' } }),
      leg('short-b', {
        instrumentId: B,
        side: 'sell_short',
        quantity: { type: 'notional', value: '5000', rounding: 'down' },
      }),
    ],
    compare(close(A), 'crosses_below', sma(20)),
    [leg('close-a', { side: 'close' }), leg('close-b', { instrumentId: B, side: 'close' })],
  );
  def.risk.priceCollarPct = '10';
  return def;
};

describe('simulate over demo history', () => {
  it('plans warm-up bars before the start date', () => {
    const plans = planSeries(pair(), inputs('2023-01-03', '2023-12-29'));
    const from = Object.fromEntries(plans.map((p) => [p.spec.instrumentId, p.from]));
    // SMA(20) plus one bar for "crosses" and the bar before: 22 bars, padded for holidays.
    expect(from).toEqual({ [A]: '2022-11-24', [B]: '2022-12-24' });
  });

  it('runs a pair strategy for a year of daily bars', async () => {
    const def = pair();
    const run = backtestInputsSchema.parse(inputs('2023-01-03', '2023-12-29'));
    const data = await loadData(provider, planSeries(def, run), INSTRUMENTS);
    const r = simulate({ definition: def, instruments: INSTRUMENTS, inputs: run, data });

    expect(r.dataVersions).toEqual([`${DEMO_HISTORY_VERSION}+adjusted-2026-10-02`]);
    expect(r.equity).toHaveLength(250);
    expect(r.trades.length).toBeGreaterThan(3);
    // The first decision can use the warm-up bars: no "insufficient data" warning.
    expect(r.warnings.map((w) => w.code)).not.toContain('insufficient_data');
    for (const t of r.trades.filter((t) => t.status === 'closed')) {
      expect(t.legs.map((l) => l.legId).sort()).toEqual([
        'close-a',
        'close-b',
        'long-a',
        'short-b',
      ]);
    }
    expect(Number(r.metrics.borrow)).toBeGreaterThan(0);
    expect(r.metrics.sharpe).not.toBeNull();
    expect(r.contributions.map((c) => c.symbol).sort()).toEqual(['DEMO-A', 'DEMO-B']);

    // Same request, same answer.
    const again = await loadData(provider, planSeries(def, run), INSTRUMENTS);
    expect(
      simulate({ definition: def, instruments: INSTRUMENTS, inputs: run, data: again }),
    ).toEqual(r);
  });

  it('runs on hourly bars and flags the bars the demo data leaves out', async () => {
    const def = pair();
    const run = backtestInputsSchema.parse(inputs('2024-01-02', '2024-06-28', { interval: '1h' }));
    const data = await loadData(provider, planSeries(def, run), INSTRUMENTS);
    const r = simulate({ definition: def, instruments: INSTRUMENTS, inputs: run, data });
    expect(r.equity.length).toBeGreaterThan(800);
    // Orders fill on hourly bars, so fills land on the hour inside the session.
    for (const f of r.fills) expect(new Date(f.time).getUTCMinutes() % 30).toBe(0);
  });

  it('runs on 5-minute bars (N178)', async () => {
    const def = pair();
    const run = backtestInputsSchema.parse(inputs('2024-03-01', '2024-03-29', { interval: '5m' }));
    const data = await loadData(provider, planSeries(def, run), INSTRUMENTS);
    const r = simulate({ definition: def, instruments: INSTRUMENTS, inputs: run, data });
    // About 78 bars a session over 20 sessions.
    expect(r.equity.length).toBeGreaterThan(1400);
    for (const f of r.fills) expect(new Date(f.time).getUTCMinutes() % 5).toBe(0);
  });
});
