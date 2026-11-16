import { describe, expect, it } from 'vitest';
import { AUTO_RESUME, autoResumeStep, type AutoPause } from './auto-resume';
import { AccountSyncGate } from './account-sync';

const T = 1_800_000_000_000;
const pause: AutoPause = { kind: 'broker_disconnected', reason: 'r', at: T };
const today = '2026-11-16';

describe('autoResumeStep (N283)', () => {
  it('waits until the backoff has passed and the cause has been clear for 30 s', () => {
    let step = autoResumeStep({ pause, counts: undefined, today, healthy: true, now: T + 10_000 });
    expect(step.action).toBe('wait');
    const healthySince = step.action === 'wait' ? step.pause.healthySince : undefined;
    expect(healthySince).toBe(T + 10_000);
    step = autoResumeStep({
      pause: { ...pause, healthySince },
      counts: undefined,
      today,
      healthy: true,
      now: T + 60_000,
    });
    expect(step).toEqual({ action: 'resume', count: { day: today, count: 1 }, attempt: 1 });
  });

  it('starts the healthy clock over when the cause comes back', () => {
    const step = autoResumeStep({
      pause: { ...pause, healthySince: T },
      counts: undefined,
      today,
      healthy: false,
      now: T + 120_000,
    });
    expect(step).toEqual({ action: 'wait', pause: { ...pause, healthySince: undefined } });
  });

  it('waits longer for each resume that day', () => {
    const at = (count: number, now: number) =>
      autoResumeStep({
        pause: { ...pause, healthySince: T },
        counts: { day: today, count },
        today,
        healthy: true,
        now,
      }).action;
    expect(at(1, T + 120_000)).toBe('wait');
    expect(at(1, T + AUTO_RESUME.delaysMs[1])).toBe('resume');
    expect(at(2, T + AUTO_RESUME.delaysMs[1])).toBe('wait');
    expect(at(2, T + AUTO_RESUME.delaysMs[2])).toBe('resume');
    // A new day starts the count again.
    expect(
      autoResumeStep({
        pause: { ...pause, healthySince: T },
        counts: { day: '2026-11-15', count: 3 },
        today,
        healthy: true,
        now: T + 60_000,
      }).action,
    ).toBe('resume');
  });

  it('gives up after 3 a day, telling the person once', () => {
    const counts = { day: today, count: AUTO_RESUME.perDay };
    const first = autoResumeStep({ pause, counts, today, healthy: true, now: T + 3_600_000 });
    expect(first.action).toBe('give_up');
    const again = autoResumeStep({
      pause: { ...pause, gaveUp: true },
      counts,
      today,
      healthy: true,
      now: T + 7_200_000,
    });
    expect(again.action).toBe('wait');
  });
});

describe('AccountSyncGate (N282)', () => {
  it('lets one pass per interval ask the broker and shares its outcome', () => {
    const gate = new AccountSyncGate(5_000);
    expect(gate.due('a', T)).toBe(true);
    gate.record('a', T, { brokerDown: false, throttled: true });
    expect(gate.due('a', T + 4_000)).toBe(false);
    expect(gate.outcome('a')).toEqual({ brokerDown: false, throttled: true });
    expect(gate.due('a', T + 5_000)).toBe(true);
    expect(gate.due('b', T + 1)).toBe(true);
  });

  it('never gates when the interval is 0', () => {
    const gate = new AccountSyncGate(0);
    gate.record('a', T, { brokerDown: false, throttled: false });
    expect(gate.due('a', T)).toBe(true);
  });
});
