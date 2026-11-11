import { describe, expect, it } from 'vitest';
import type { BarInterval } from './catalog';
import {
  defaultSchedule,
  isCalendarSchedule,
  scheduleBarMinutes,
  scheduledPeriod,
  scheduleLabel,
  scheduleOf,
} from './schedule';
import { SCHEDULE_FREQUENCIES, scheduleFrom, type Schedule } from './schema';
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
function evaluations(
  frequency: Parameters<typeof scheduleFrom>[0] | Schedule,
  times: number[],
): number[] {
  const schedule = typeof frequency === 'string' ? scheduleFrom(frequency) : frequency;
  let last: string | undefined;
  const out: number[] = [];
  for (const t of times) {
    const p = scheduledPeriod(schedule, t, last);
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
  it('names each saved choice in the three boxes, and keeps calendar periods apart', () => {
    expect(SCHEDULE_FREQUENCIES.map((f) => scheduleLabel(scheduleFrom(f)))).toEqual([
      'Every 1-minute bar, every trading day',
      'Every 5-minute bar, every trading day',
      'Every 1-hour bar, every trading day',
      'After the close, every trading day',
      'After the close, last trading day of each week',
      'After the close, last trading day of each month',
      'After the close, last trading day of each quarter',
      'After the close, last trading day of each year',
    ]);
    expect(SCHEDULE_FREQUENCIES.filter((f) => isCalendarSchedule(scheduleFrom(f)))).toEqual([
      'weekly',
      'monthEnd',
      'quarterEnd',
      'yearEnd',
    ]);
  });

  it('defaults to the cadence of the finest bars the rules read', () => {
    expect(defaultSchedule(reading('1m'))).toEqual(scheduleFrom('bar1m'));
    expect(defaultSchedule(reading('5m'))).toEqual(scheduleFrom('bar5m'));
    expect(defaultSchedule(reading('15m'))).toEqual(scheduleFrom('bar5m'));
    expect(defaultSchedule(reading('1h'))).toEqual(scheduleFrom('bar1h'));
    expect(defaultSchedule(reading('4h'))).toEqual(scheduleFrom('bar1h'));
    expect(defaultSchedule(reading('1d'))).toEqual(scheduleFrom('daily'));
    expect(defaultSchedule(reading('1w'))).toEqual(scheduleFrom('daily'));
    const base = reading('5m');
    const picked = { ...base, entry: { ...base.entry, schedule: scheduleFrom('daily') } };
    expect(scheduleOf(picked)).toEqual(scheduleFrom('daily'));
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
    const first = scheduledPeriod(scheduleFrom('bar5m'), bar + 20_000, undefined, bar);
    expect(first).toBeDefined();
    expect(scheduledPeriod(scheduleFrom('bar5m'), bar + 40_000, first, bar)).toBeUndefined();
    expect(
      scheduledPeriod(scheduleFrom('bar5m'), bar + 300_000, first, bar + 300_000),
    ).toBeDefined();
  });
});

describe('Which bar, bar size and days (N226, N227)', () => {
  const open = at('2026-03-10T13:30:00Z');
  const checks = (schedule: Schedule, times: number[], beforeOpenAtClose = false): number[] => {
    let last: string | undefined;
    const out: number[] = [];
    for (const t of times) {
      const p = scheduledPeriod(schedule, t, last, t, { beforeOpenAtClose });
      if (p !== undefined) {
        last = p;
        out.push(t);
      }
    }
    return out;
  };
  const bars5 = Array.from({ length: 78 }, (_, i) => open + (i + 1) * 5 * 60_000);
  const s = (which: Schedule['which'], bar: Schedule['bar'], days: Schedule['days'] = 'daily') => ({
    which,
    bar,
    days,
  });

  it('reads saved after-the-open choices as the 1st bar', () => {
    expect(scheduleFrom('monthEnd', 'open5m')).toEqual(s('first', '5m', 'monthEnd'));
    expect(scheduleFrom('daily', 'open1h')).toEqual(s('first', '1h'));
    expect(scheduleFrom('weekly', 'close')).toEqual(s('every', '1d', 'weekly'));
  });

  it('checks the 1st and 2nd bar once a day, at the first bar ending that long after the open', () => {
    expect(checks(s('first', '5m'), bars5)).toEqual([open + 5 * 60_000]);
    expect(checks(s('second', '5m'), bars5)).toEqual([open + 10 * 60_000]);
    expect(checks(s('first', '1h'), bars5)).toEqual([open + 60 * 60_000]);
    expect(checks(s('second', '30m'), bars5)).toEqual([open + 60 * 60_000]);
    // 1-minute: the first 5-minute bar is the first bar in after one minute.
    expect(checks(s('first', '1m'), bars5)).toEqual([open + 5 * 60_000]);
  });

  it('checks every 30-minute bar on the half hours', () => {
    const got = checks(s('every', '30m'), bars5);
    expect(got).toHaveLength(14);
    for (const t of got.slice(1)) expect(new Date(t).getUTCMinutes() % 30).toBe(0);
  });

  it('checks the last bar at the close', () => {
    expect(checks(s('last', '5m'), bars5)).toEqual([bars5[0], at('2026-03-10T20:00:00Z')]);
  });

  it('does not check before the open, nor on a day without a session', () => {
    expect(checks(s('first', '5m'), [open - 60_000, open])).toEqual([]);
    expect(checks(s('first', '5m'), [at('2026-03-14T15:00:00Z')])).toEqual([]); // Saturday
  });

  it('limits every bar to the scheduled days', () => {
    // 2026-03-31 is the last trading day of March.
    const days = ['2026-03-30', '2026-03-31', '2026-04-01'].map((d) => at(`${d}T14:00:00Z`));
    expect(checks(s('first', '5m', 'monthEnd'), days)).toEqual([days[1]]);
    expect(checks(s('every', '5m', 'monthEnd'), days)).toEqual([days[1]]);
  });

  it('checks before the open: one bar ahead in paper runs, at the prior close in back tests', () => {
    // 2026-03-10 opens 13:30Z; the day before closed 20:00Z.
    const ticks = [
      at('2026-03-09T20:00:00Z'),
      at('2026-03-10T13:00:00Z'),
      at('2026-03-10T13:25:00Z'),
    ];
    expect(checks(s('beforeOpen', '5m'), ticks)).toEqual([ticks[2]]);
    expect(checks(s('beforeOpen', '1h'), ticks)).toEqual([ticks[1]]);
    expect(checks(s('beforeOpen', '5m'), ticks, true)).toEqual([ticks[0]]);
    // Before the open on month end: the evening before the last trading day of March.
    const closes = ['2026-03-27', '2026-03-30', '2026-03-31'].map((d) => at(`${d}T20:00:00Z`));
    expect(checks(s('beforeOpen', '5m', 'monthEnd'), closes, true)).toEqual([closes[1]]);
  });

  it('counts a daily bar ending at the close, so daily runs check the 1st bar at the close', () => {
    const closes = [at('2026-03-10T20:00:00Z'), at('2026-03-11T20:00:00Z')];
    expect(checks(s('first', '5m'), closes)).toEqual(closes);
  });

  it('labels and bar minutes', () => {
    expect(scheduleLabel(s('first', '5m'))).toBe('1st 5-minute bar, every trading day');
    expect(scheduleLabel(s('second', '30m', 'monthEnd'))).toBe(
      '2nd 30-minute bar, last trading day of each month',
    );
    expect(scheduleLabel(s('first', '1d', 'monthEnd'))).toBe(
      'After the close, last trading day of each month',
    );
    expect(scheduleLabel(s('beforeOpen', '5m', 'weekly'))).toBe(
      'Before the open, last trading day of each week',
    );
    expect(scheduleBarMinutes(s('first', '5m', 'weekly'))).toBe(5);
    expect(scheduleBarMinutes(s('second', '30m'))).toBe(60);
    expect(scheduleBarMinutes(s('every', '1d', 'weekly'))).toBeUndefined();
    expect(scheduleBarMinutes(s('every', '1h'))).toBe(60);
    expect(scheduleBarMinutes(s('beforeOpen', '5m'))).toBeUndefined();
  });
});
