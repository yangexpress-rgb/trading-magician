import { describe, expect, it } from 'vitest';
import type { BarInterval } from './catalog';
import {
  defaultSchedule,
  isCalendarSchedule,
  scheduleBarMinutes,
  scheduledPeriod,
  scheduleLabel,
  scheduleOf,
  SCHEDULE_LABELS,
} from './schedule';
import { SCHEDULE_FREQUENCIES, type ScheduleTime } from './schema';
import { comparison, indicator, market, validDefinition } from './test-fixtures';

const at = (iso: string) => Date.parse(iso);

function reading(interval: BarInterval) {
  const d = validDefinition();
  d.entry.condition.children = [
    comparison('c', market('m', { interval }), 'gt', indicator('i', { interval })),
  ];
  d.exit.condition.children = [];
  return d;
}

/** Times of a list at which Entry is evaluated, remembering the last period. */
function evaluations(frequency: Parameters<typeof scheduledPeriod>[0], times: number[]): number[] {
  let last: string | undefined;
  const out: number[] = [];
  for (const t of times) {
    const p = scheduledPeriod(frequency, t, last);
    if (p !== undefined) {
      last = p;
      out.push(t);
    }
  }
  return out;
}

/** Bar ends every `minutes` through one regular session (2026-03-10, EDT). */
function sessionBars(minutes: number): number[] {
  const open = at('2026-03-10T13:30:00Z');
  const out: number[] = [];
  for (let t = open + minutes * 60_000; t <= at('2026-03-10T20:00:00Z'); t += minutes * 60_000)
    out.push(t);
  return out;
}

describe('Entry schedule (N184)', () => {
  it('names each bar size and keeps calendar periods apart', () => {
    expect(SCHEDULE_FREQUENCIES.map((f) => SCHEDULE_LABELS[f])).toEqual([
      'Every 1-minute bar',
      'Every 5-minute bar',
      'Every hourly bar',
      'Once a day, after the close',
      'Last trading day of each week',
      'Last trading day of each month',
      'Last trading day of each quarter',
      'Last trading day of each year',
    ]);
    expect(SCHEDULE_FREQUENCIES.filter(isCalendarSchedule)).toEqual([
      'weekly',
      'monthEnd',
      'quarterEnd',
      'yearEnd',
    ]);
  });

  it('defaults to the cadence of the finest bars the rules read', () => {
    expect(defaultSchedule(reading('1m'))).toBe('bar1m');
    expect(defaultSchedule(reading('5m'))).toBe('bar5m');
    expect(defaultSchedule(reading('15m'))).toBe('bar5m');
    expect(defaultSchedule(reading('1h'))).toBe('bar1h');
    expect(defaultSchedule(reading('4h'))).toBe('bar1h');
    expect(defaultSchedule(reading('1d'))).toBe('daily');
    expect(defaultSchedule(reading('1w'))).toBe('daily');
    const base = reading('5m');
    const picked = { ...base, entry: { ...base.entry, schedule: { frequency: 'daily' as const } } };
    expect(scheduleOf(picked)).toBe('daily');
  });

  it('checks every bar of the picked size, and every bar when the bars are coarser', () => {
    const fiveMinute = sessionBars(5);
    expect(evaluations('bar5m', fiveMinute)).toEqual(fiveMinute);
    expect(evaluations('bar1m', fiveMinute)).toEqual(fiveMinute);
    // On 1-minute bars, a 5-minute cadence checks the bar ending on each
    // boundary, after the session's first bar (9:31).
    const oneMinute = sessionBars(1);
    const [first, ...checked] = evaluations('bar5m', oneMinute);
    expect(first).toBe(at('2026-03-10T13:31:00Z'));
    expect(checked).toHaveLength(78);
    for (const t of checked) expect(new Date(t).getUTCMinutes() % 5).toBe(0);
    // Hourly: the top of each hour, plus 10:00 after the 9:30 open.
    expect(evaluations('bar1h', fiveMinute).map((t) => new Date(t).toISOString())).toEqual([
      '2026-03-10T13:35:00.000Z',
      '2026-03-10T14:00:00.000Z',
      '2026-03-10T15:00:00.000Z',
      '2026-03-10T16:00:00.000Z',
      '2026-03-10T17:00:00.000Z',
      '2026-03-10T18:00:00.000Z',
      '2026-03-10T19:00:00.000Z',
      '2026-03-10T20:00:00.000Z',
    ]);
  });

  it('checks once a day after the close, whatever the bar size', () => {
    const twoDays = [...sessionBars(5), ...sessionBars(5).map((t) => t + 86_400_000)];
    const checked = evaluations('daily', twoDays).map((t) => new Date(t).toISOString());
    // The first bar of the run counts for the day before; then each close.
    expect(checked).toEqual([
      '2026-03-10T13:35:00.000Z',
      '2026-03-10T20:00:00.000Z',
      '2026-03-11T20:00:00.000Z',
    ]);
    // On daily bars (which end at the close) every bar is checked.
    const closes = ['2026-03-09', '2026-03-10', '2026-03-11'].map((d) => at(`${d}T20:00:00Z`));
    expect(evaluations('daily', closes)).toEqual(closes);
  });

  it('keys bar cadences by the newest bar, not the time of the check', () => {
    const bar = at('2026-03-10T14:05:00Z');
    const first = scheduledPeriod('bar5m', bar + 20_000, undefined, bar);
    expect(first).toBeDefined();
    expect(scheduledPeriod('bar5m', bar + 40_000, first, bar)).toBeUndefined();
    expect(scheduledPeriod('bar5m', bar + 300_000, first, bar + 300_000)).toBeDefined();
  });
});

describe('Checks after the open (N226)', () => {
  const open = at('2026-03-10T13:30:00Z');
  const opens = (
    frequency: Parameters<typeof scheduledPeriod>[0],
    when: ScheduleTime,
    times: number[],
  ): number[] => {
    let last: string | undefined;
    const out: number[] = [];
    for (const t of times) {
      const p = scheduledPeriod(frequency, t, last, t, when);
      if (p !== undefined) {
        last = p;
        out.push(t);
      }
    }
    return out;
  };

  it('checks once a day, at the first bar ending at least N minutes after the open', () => {
    const bars = Array.from({ length: 78 }, (_, i) => open + (i + 1) * 5 * 60_000);
    expect(opens('daily', 'open5m', bars)).toEqual([open + 5 * 60_000]);
    expect(opens('daily', 'open1h', bars)).toEqual([open + 60 * 60_000]);
    // 1-minute: the first 5-minute bar is the first bar in after one minute.
    expect(opens('daily', 'open1m', bars)).toEqual([open + 5 * 60_000]);
  });

  it('does not check before the open, nor on a day without a session', () => {
    expect(opens('daily', 'open5m', [open - 60_000, open])).toEqual([]);
    expect(opens('daily', 'open5m', [at('2026-03-14T15:00:00Z')])).toEqual([]); // Saturday
  });

  it('checks a calendar period only on its last trading day', () => {
    // 2026-03-31 is the last trading day of March.
    const days = ['2026-03-30', '2026-03-31', '2026-04-01'].map((d) => at(`${d}T14:00:00Z`));
    expect(opens('monthEnd', 'open5m', days)).toEqual([days[1]]);
  });

  it('counts a daily bar ending at the close, so daily runs check at the close', () => {
    const closes = [at('2026-03-10T20:00:00Z'), at('2026-03-11T20:00:00Z')];
    expect(opens('daily', 'open5m', closes)).toEqual(closes);
  });

  it('keys apart from the after-the-close check and ignores the time on bar cadences', () => {
    const t = open + 10 * 60_000;
    expect(scheduledPeriod('daily', t, undefined, t, 'open5m')).toMatch(/^O/);
    expect(scheduledPeriod('bar5m', t, undefined, t, 'open1h')).toBe(
      scheduledPeriod('bar5m', t, undefined, t),
    );
  });

  it('labels and bar minutes', () => {
    expect(scheduleLabel('daily', 'open5m')).toBe('Once a day, after the first 5-minute bar');
    expect(scheduleLabel('monthEnd', 'open1h')).toBe(
      'Last trading day of each month, after the first hour',
    );
    expect(scheduleLabel('monthEnd', 'close')).toBe(SCHEDULE_LABELS.monthEnd);
    expect(scheduleBarMinutes({ frequency: 'weekly', at: 'open5m' })).toBe(5);
    expect(scheduleBarMinutes({ frequency: 'weekly' })).toBeUndefined();
    expect(scheduleBarMinutes({ frequency: 'bar1h', at: 'open5m' })).toBe(60);
  });
});
