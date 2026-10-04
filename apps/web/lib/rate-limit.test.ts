import { describe, expect, it } from 'vitest';
import { createRateLimiter } from './rate-limit';

describe('rate limiter', () => {
  it('allows up to the limit per window and key', () => {
    let t = 0;
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000, now: () => t });
    expect(limiter.hit('a')).toBe(0);
    expect(limiter.hit('a')).toBe(0);
    expect(limiter.hit('b')).toBe(0);
    t = 15_000;
    expect(limiter.hit('a')).toBe(45);
    t = 60_000;
    expect(limiter.hit('a')).toBe(0);
  });
});
