import { describe, expect, it } from 'vitest';
import { FALLBACK_LIMITS, assertPaperOnlyLimits, resolveLimits } from './plans';

describe('resolveLimits', () => {
  it("takes the plan's limits, then the user's overrides", () => {
    const limits = resolveLimits(
      { savedStrategies: 3, activeStrategies: 1, paperIntegrations: false },
      { activeStrategies: 2 },
    );
    expect(limits).toMatchObject({
      savedStrategies: 3,
      activeStrategies: 2,
      paperIntegrations: false,
    });
  });

  it('falls back to the most restrictive value for anything missing or malformed', () => {
    const limits = resolveLimits(
      { savedStrategies: -1, activeStrategies: '5', liveData: 'yes', backtestRunsPerDay: 2.5 },
      null,
    );
    expect(limits).toEqual(FALLBACK_LIMITS);
    expect(resolveLimits(undefined)).toEqual(FALLBACK_LIMITS);
  });

  it('never allows real-money trading', () => {
    expect(() => assertPaperOnlyLimits(resolveLimits({ realIntegrations: true }))).toThrow(
      /Phase 7/,
    );
    expect(() => assertPaperOnlyLimits(FALLBACK_LIMITS)).not.toThrow();
  });
});
