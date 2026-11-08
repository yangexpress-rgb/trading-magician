import { describe, expect, it } from 'vitest';
import { AlpacaRequestBudget } from './budget';
import { AlpacaClient, AlpacaRateLimitError } from './client';

/** A key's request budget (ADR 0052): background work yields to everything else. */

function clock() {
  let t = 1_000_000;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
    advance: (ms: number) => (t += ms),
    slept,
  };
}

describe('the Alpaca request budget', () => {
  it('never delays a foreground request', async () => {
    const c = clock();
    const budget = new AlpacaRequestBudget({ now: c.now, sleep: c.sleep });
    for (let i = 0; i < 250; i++) await budget.take('k', false);
    expect(c.slept).toEqual([]);
    expect(budget.sentLastMinute('k')).toBe(250);
  });

  it('caps background requests at their share of the minute', async () => {
    const c = clock();
    const budget = new AlpacaRequestBudget({
      backgroundPerMinute: 3,
      now: c.now,
      sleep: c.sleep,
    });
    for (let i = 0; i < 3; i++) await budget.take('k', true);
    expect(c.slept).toEqual([]);
    await budget.take('k', true);
    expect(c.slept.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(60_000);
  });

  it('keeps background requests out of the room left for everything else', async () => {
    const c = clock();
    const budget = new AlpacaRequestBudget({
      perMinute: 10,
      reserve: 4,
      backgroundPerMinute: 10,
      now: c.now,
      sleep: c.sleep,
    });
    for (let i = 0; i < 6; i++) await budget.take('k', false);
    c.advance(30_000);
    await budget.take('k', true);
    // It waited for the foreground minute to pass, about 30 s more.
    expect(c.slept.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(30_000);
    // Another key's budget is its own.
    const before = c.slept.length;
    await budget.take('other', true);
    expect(c.slept.length).toBe(before);
  });

  it('stands background requests aside after a 429', async () => {
    const c = clock();
    const budget = new AlpacaRequestBudget({ now: c.now, sleep: c.sleep });
    budget.throttled('k', 5_000);
    await budget.take('k', false);
    expect(c.slept).toEqual([]);
    await budget.take('k', true);
    expect(c.slept).toEqual([5_000]);
    budget.throttled('k', undefined);
    await budget.take('k', true);
    expect(c.slept.at(-1)).toBe(60_000);
  });

  it('is shared by clients signing with the same key, and learns of 429s', async () => {
    const c = clock();
    const budget = new AlpacaRequestBudget({ now: c.now, sleep: c.sleep });
    let status = 200;
    const fetch = async () =>
      new Response(status === 200 ? '{}' : 'slow down', {
        status,
        headers: status === 429 ? { 'retry-after': '7' } : {},
      });
    const credentials = { keyId: 'KEY', secretKey: 'S' };
    const person = new AlpacaClient({ credentials, fetch, budget });
    const recorder = new AlpacaClient({ credentials, fetch, budget, background: true });
    await person.data('/v2/stocks/bars');
    await recorder.data('/v2/stocks/bars');
    expect(budget.sentLastMinute('KEY')).toBe(2);
    status = 429;
    await expect(person.data('/v2/stocks/bars')).rejects.toBeInstanceOf(AlpacaRateLimitError);
    status = 200;
    await recorder.data('/v2/stocks/bars');
    expect(c.slept).toEqual([7_000]);
  });
});
