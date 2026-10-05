import { resolveLimits } from '@tm/domain';
import { describe, expect, it } from 'vitest';
import { COMPARED_LIMITS, formatPrice, limitValue, usageRows } from './billing-text';

describe('billing text', () => {
  it('formats prices', () => {
    expect(formatPrice(0, 'USD', 'month')).toBe('Free');
    expect(formatPrice(2000, 'USD', 'month')).toBe('$20 a month');
    expect(formatPrice(1999, 'USD', 'month')).toBe('$19.99 a month');
  });

  it('shows usage against each limit, and flags a full one', () => {
    const limits = resolveLimits({ savedStrategies: 3, activeStrategies: 1, connectedAccounts: 1 });
    const rows = usageRows(limits, {
      savedStrategies: 3,
      activeStrategies: 0,
      backtestRunsPerDay: 0,
      concurrentBacktests: 0,
      connectedAccounts: 2,
    });
    expect(rows.map((r) => [r.label, r.used, r.allowed, r.full])).toEqual([
      ['Saved strategies', 3, 3, true],
      ['Active strategies', 0, 1, false],
      ['Back tests per day', 0, 1, false],
      ['Active trading accounts', 2, 1, true],
    ]);
  });

  it('never lists real-money trading', () => {
    expect(COMPARED_LIMITS).not.toContain('realIntegrations');
    expect(limitValue(resolveLimits({ liveData: true }), 'liveData')).toBe('Included');
  });
});
