import { describe, expect, it, vi } from 'vitest';
import { startMembershipSync } from './membership-sync';

describe('membership sync schedule (N324)', () => {
  it('retries soon when the table is not there yet, never stopping the worker', async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    let calls = 0;
    const loop = startMembershipSync({
      db: {} as never,
      resolve: async () => {
        calls++;
        throw new Error('relation "group_membership_period" does not exist');
      },
      barsFrom: '2016-01-04',
      now: () => new Date('2026-11-23T15:00:00Z'),
      logger: { info: () => {}, warn },
      periods: [{ symbol: 'AAPL', from: '2016-01-04', to: null }],
      retryMs: 1_000,
      everyMs: 86_400_000,
    });
    await loop.done;
    expect(calls).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringMatching(/trying again shortly/),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(2);
    loop.stop();
    vi.useRealTimers();
  });
});
