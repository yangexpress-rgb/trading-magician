import { describe, expect, it } from 'vitest';
import { lookbackFits, lookbackStart } from './inputs';

describe('look-back periods (N234)', () => {
  it('counts calendar weeks, months and years back from the end date', () => {
    expect(lookbackStart('2026-11-11', '1w')).toBe('2026-11-04');
    expect(lookbackStart('2026-11-11', '2w')).toBe('2026-10-28');
    expect(lookbackStart('2026-11-11', '1m')).toBe('2026-10-11');
    expect(lookbackStart('2026-11-11', '6m')).toBe('2026-05-11');
    expect(lookbackStart('2026-11-11', '1y')).toBe('2025-11-11');
    expect(lookbackStart('2026-11-11', '5y')).toBe('2021-11-11');
  });

  it("uses the month's last day when the day doesn't exist", () => {
    expect(lookbackStart('2026-03-31', '1m')).toBe('2026-02-28');
    expect(lookbackStart('2024-02-29', '1y')).toBe('2023-02-28');
  });

  it("fits each period to the strategy's bars", () => {
    expect(lookbackFits('2026-11-11', '1m', '5m')).toBe(true);
    expect(lookbackFits('2026-11-11', '3m', '5m')).toBe(false);
    expect(lookbackFits('2026-11-11', '1y', '1h')).toBe(true);
    expect(lookbackFits('2026-11-11', '2y', '1h')).toBe(false);
    expect(lookbackFits('2026-11-11', '5y', '1d')).toBe(true);
  });
});
