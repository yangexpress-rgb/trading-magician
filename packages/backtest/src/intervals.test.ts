import { scheduleFrom } from '@tm/domain';
import { describe, expect, it } from 'vitest';
import type { ScheduleFrequency, StrategyDefinition } from '@tm/domain';
import { coarserThan, matchingBacktestInterval } from './data';
import { MAX_RANGE_DAYS, backtestInputsSchema, describeAssumptions } from './inputs';
import { close, compare, constant, inputs, leg, strategy } from './test-utils';

/** A strategy whose Entry reads the close at `interval`. */
function readingAt(interval: Parameters<typeof withInterval>[0]) {
  return strategy(
    compare(withInterval(interval), 'gt', constant('1')),
    [leg('e')],
    compare(close(), 'lt', constant('1')),
    [leg('x', { side: 'sell' })],
  );
}
function withInterval(interval: '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d' | '1w') {
  return { ...close(), interval };
}

function onSchedule(def: StrategyDefinition, frequency: ScheduleFrequency): StrategyDefinition {
  return { ...def, entry: { ...def.entry, schedule: scheduleFrom(frequency) } };
}

describe('5-minute back tests (N178)', () => {
  it('accepts 5-minute runs of up to 31 days', () => {
    expect(MAX_RANGE_DAYS['5m']).toBe(31);
    const ok = backtestInputsSchema.safeParse(
      inputs('2025-03-01', '2025-03-31', { interval: '5m' }),
    );
    expect(ok.success).toBe(true);
    const long = backtestInputsSchema.safeParse(
      inputs('2025-03-01', '2025-04-15', { interval: '5m' }),
    );
    expect(long.success).toBe(false);
    expect(long.error?.issues[0]?.message).toBe('5-minute back tests can cover at most 31 days');
  });

  it('names 5-minute bars in the assumptions', () => {
    const run = backtestInputsSchema.parse(inputs('2025-03-03', '2025-03-07', { interval: '5m' }));
    expect(describeAssumptions(run)[0]).toMatch(/^5-minute bars from 2025-03-03/);
  });
});

describe('the run interval that matches the rules (N179)', () => {
  it.each([
    ['1m', '5m'],
    ['5m', '5m'],
    ['15m', '5m'],
    ['30m', '5m'],
    ['1h', '1h'],
    ['4h', '1h'],
    ['1d', '1d'],
    ['1w', '1d'],
  ] as const)('conditions on %s bars run on %s bars', (rules, run) => {
    // The Exit reads daily closes; the finest bars win.
    expect(matchingBacktestInterval(readingAt(rules))).toEqual({
      interval: run,
      finest: rules === '1w' ? '1d' : rules,
    });
  });

  it('is daily when no condition reads bars', () => {
    const def = strategy(
      compare(constant('1'), 'gt', constant('0')),
      [leg('e')],
      compare(constant('1'), 'lt', constant('0')),
      [leg('x', { side: 'sell' })],
    );
    expect(matchingBacktestInterval(def)).toEqual({ interval: '1d', finest: undefined });
  });

  it('runs at least as finely as a picked Entry bar cadence (N184)', () => {
    const daily = readingAt('1d');
    expect(matchingBacktestInterval(onSchedule(daily, 'bar5m')).interval).toBe('5m');
    expect(matchingBacktestInterval(onSchedule(daily, 'bar1m')).interval).toBe('5m');
    expect(matchingBacktestInterval(onSchedule(daily, 'bar1h')).interval).toBe('1h');
    expect(matchingBacktestInterval(onSchedule(readingAt('5m'), 'daily')).interval).toBe('5m');
  });

  it('runs finely enough for a check after the open (N226)', () => {
    const daily = readingAt('1d');
    const at = (time: 'open1m' | 'open5m' | 'open1h') => ({
      ...daily,
      entry: { ...daily.entry, schedule: scheduleFrom('monthEnd', time) },
    });
    expect(matchingBacktestInterval(at('open1m')).interval).toBe('5m');
    expect(matchingBacktestInterval(at('open5m')).interval).toBe('5m');
    expect(matchingBacktestInterval(at('open1h')).interval).toBe('1h');
    expect(matchingBacktestInterval(onSchedule(daily, 'monthEnd')).interval).toBe('1d');
  });

  it('says when the run steps more coarsely than the rules', () => {
    expect(coarserThan('1h', '5m')).toBe(true);
    expect(coarserThan('5m', '1m')).toBe(true);
    expect(coarserThan('5m', '5m')).toBe(false);
    expect(coarserThan('5m', '1d')).toBe(false);
  });
});
