import type { IndicatorExpr, ScheduleFrequency, StrategyDefinition } from '@tm/domain';
import { createDemoHistoryProvider, DEMO_HISTORY_VERSION } from '@tm/market-data';
import { describe, expect, it } from 'vitest';
import { loadData, planSeries } from './data';
import { simulate } from './engine';
import { backtestInputsSchema } from './inputs';
import { A, B, INSTRUMENTS, close, compare, constant, inputs, leg, strategy } from './test-utils';

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

function onSchedule(def: StrategyDefinition, frequency: ScheduleFrequency): StrategyDefinition {
  return { ...def, entry: { ...def.entry, schedule: { frequency } } };
}

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

  it('checks Entry on the picked schedule, whatever the bars (N184)', async () => {
    const run = backtestInputsSchema.parse(inputs('2024-03-01', '2024-03-29', { interval: '5m' }));
    const everyBar = onSchedule(pair(), 'bar5m');
    const data = await loadData(provider, planSeries(everyBar, run), INSTRUMENTS);
    const a = simulate({ definition: everyBar, instruments: INSTRUMENTS, inputs: run, data });
    const onceADay = onSchedule(pair(), 'daily');
    const b = simulate({ definition: onceADay, instruments: INSTRUMENTS, inputs: run, data });
    // Once a day, Entry is decided at a close, so its fills land at the next open (9:30 New York).
    const buys = b.fills.filter((f) => f.side === 'buy');
    expect(buys.length).toBeGreaterThan(0);
    for (const f of buys)
      expect(new Date(f.time).toISOString().slice(11, 16)).toMatch(/^(13|14):30$/);
    expect(a.warnings.some((w) => w.code === 'schedule_finer_than_bars')).toBe(false);
    const oneMinute = onSchedule(pair(), 'bar1m');
    const c = simulate({ definition: oneMinute, instruments: INSTRUMENTS, inputs: run, data });
    expect(c.warnings.find((w) => w.code === 'schedule_finer_than_bars')?.message).toBe(
      'Entry is set to "Every 1-minute bar", but this run steps on 5-minute bars, so Entry was checked once a 5-minute bar',
    );
  });

  it('checks Entry after the open on the picked bar (N226)', async () => {
    const run = backtestInputsSchema.parse(inputs('2024-03-01', '2024-03-29', { interval: '5m' }));
    const def: StrategyDefinition = {
      ...pair(),
      entry: { ...pair().entry, schedule: { frequency: 'daily', at: 'open1h' } },
    };
    const data = await loadData(provider, planSeries(def, run), INSTRUMENTS);
    const r = simulate({ definition: def, instruments: INSTRUMENTS, inputs: run, data });
    // Decided at 10:30 New York, so buys fill on the bar that starts then.
    const buys = r.fills.filter((f) => f.side === 'buy');
    expect(buys.length).toBeGreaterThan(0);
    for (const f of buys)
      expect(new Date(f.time).toISOString().slice(11, 16)).toMatch(/^(14|15):30$/);
    expect(r.plan?.entryScheduleAt).toBe('open1h');
    expect(r.warnings.some((w) => w.code === 'schedule_finer_than_bars')).toBe(false);

    const hourly = backtestInputsSchema.parse(
      inputs('2024-03-01', '2024-03-29', { interval: '1h' }),
    );
    const firstBar: StrategyDefinition = {
      ...def,
      entry: { ...def.entry, schedule: { frequency: 'daily', at: 'open5m' } },
    };
    const hourlyData = await loadData(provider, planSeries(firstBar, hourly), INSTRUMENTS);
    const h = simulate({
      definition: firstBar,
      instruments: INSTRUMENTS,
      inputs: hourly,
      data: hourlyData,
    });
    expect(h.warnings.find((w) => w.code === 'schedule_finer_than_bars')?.message).toBe(
      'Entry is set to "Once a day, after the first 5-minute bar", but this run steps on hourly bars, so Entry was checked at the end of the day\'s first hourly bar',
    );
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

  it('reads stops at the Check Exit bar size (O144, ADR 0073)', async () => {
    const run = backtestInputsSchema.parse(inputs('2024-03-01', '2024-03-29', { interval: '5m' }));
    const withTrail = (exit: ScheduleFrequency) => {
      // Enter at every daily check while flat; exit only by a 0.5% trailing stop.
      const def = onSchedule(pair(), 'daily');
      def.entry.condition.children = [compare(close(A), 'gt', constant('0'))];
      def.entry.trigger = { ...def.entry.trigger, mode: 'while_true' };
      def.exit = {
        ...def.exit,
        condition: { ...def.exit.condition, children: [] },
        schedule: { frequency: exit },
        rules: [{ kind: 'trailingStop', id: 'ts', percent: '0.5' }],
      };
      return def;
    };
    const intraday = withTrail('bar5m');
    const daily = withTrail('daily');
    // The stop's closes are 5-minute closes, which the run loads.
    const plans = planSeries(intraday, run);
    expect(plans.some((p) => p.spec.instrumentId === A && p.spec.interval === '5m')).toBe(true);
    const data = await loadData(provider, plans, INSTRUMENTS);
    const fillTimes = (def: StrategyDefinition) =>
      simulate({ definition: def, instruments: INSTRUMENTS, inputs: run, data })
        .trades.filter((t) => t.exitReason === 'trailing_stop')
        .map((t) => new Date(t.exitTime!).toISOString().slice(11, 16));
    // Checked once a day, a stop is decided at the close and fills at the next open.
    const onClose = fillTimes(daily);
    expect(onClose.length).toBeGreaterThan(0);
    for (const t of onClose) expect(t).toMatch(/^(13|14):30$/);
    // Checked every 5 minutes, it is decided on a 5-minute close inside the session.
    const inSession = fillTimes(intraday);
    expect(inSession.length).toBeGreaterThan(0);
    expect(inSession.some((t) => !/^(13|14):30$/.test(t))).toBe(true);
  });
});
