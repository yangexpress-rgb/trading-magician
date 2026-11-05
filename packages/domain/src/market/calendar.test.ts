import { describe, expect, it } from 'vitest';
import {
  isEarlyClose,
  isTradingDay,
  nextTradingDay,
  nyDate,
  nyseHolidays,
  regularSession,
  tradingDays,
} from './calendar';

describe('NYSE calendar', () => {
  it('matches the published 2025 holiday list', () => {
    expect([...nyseHolidays(2025).keys()].sort()).toEqual([
      '2025-01-01',
      '2025-01-09',
      '2025-01-20',
      '2025-02-17',
      '2025-04-18',
      '2025-05-26',
      '2025-06-19',
      '2025-07-04',
      '2025-09-01',
      '2025-11-27',
      '2025-12-25',
    ]);
  });

  it('observes weekend holidays on the nearest weekday, except a Saturday New Year', () => {
    // July 4, 2026 is a Saturday; Christmas 2021 a Saturday; New Year 2022 a Saturday.
    expect(isTradingDay('2026-07-03')).toBe(false);
    expect(isTradingDay('2021-12-24')).toBe(false);
    expect(isTradingDay('2021-12-31')).toBe(true);
    // Juneteenth 2022 fell on a Sunday and was observed on Monday the 20th.
    expect(isTradingDay('2022-06-20')).toBe(false);
    expect(isTradingDay('2021-06-18')).toBe(true);
  });

  it('knows the 1 p.m. early closes', () => {
    expect(isEarlyClose('2025-07-03')).toBe(true);
    expect(isEarlyClose('2025-11-28')).toBe(true);
    expect(isEarlyClose('2025-12-24')).toBe(true);
    expect(isEarlyClose('2026-07-02')).toBe(false);
    expect(regularSession('2025-11-28')).toEqual({
      date: '2025-11-28',
      open: '2025-11-28T14:30:00.000Z',
      close: '2025-11-28T18:00:00.000Z',
      earlyClose: true,
    });
  });

  it('places sessions in UTC across daylight-saving changes', () => {
    expect(regularSession('2026-03-06')?.open).toBe('2026-03-06T14:30:00.000Z');
    expect(regularSession('2026-03-09')?.open).toBe('2026-03-09T13:30:00.000Z');
    expect(regularSession('2026-03-07')).toBeUndefined();
  });

  it('counts about 252 trading days a year', () => {
    expect(tradingDays('2024-01-01', '2024-12-31')).toHaveLength(252);
    expect(tradingDays('2025-01-01', '2025-12-31')).toHaveLength(250);
    expect(nextTradingDay('2025-12-24')).toBe('2025-12-26');
    expect(nyDate('2025-12-24T03:00:00Z')).toBe('2025-12-23');
  });
});
