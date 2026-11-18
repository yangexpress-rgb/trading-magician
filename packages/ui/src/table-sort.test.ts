import { describe, expect, it } from 'vitest';
import {
  columnValues,
  compareValues,
  isBlank,
  nextSort,
  parseDate,
  parseNumber,
  parseSort,
  sortedOrder,
} from './table-sort';

describe('parseNumber (N303)', () => {
  it('reads amounts, percentages and counts as the app prints them', () => {
    expect(parseNumber('+$524.68+1.06%')).toBe(524.68);
    expect(parseNumber('−$1,573.26')).toBe(-1573.26);
    expect(parseNumber('-$3.12 -0.19%')).toBe(-3.12);
    expect(parseNumber('+0.55%of $49,850.21')).toBe(0.55);
    expect(parseNumber('28')).toBe(28);
    expect(parseNumber('$0.00—')).toBe(0);
    expect(parseNumber('1.2M')).toBe(1_200_000);
    expect(parseNumber('$3.4B')).toBe(3_400_000_000);
    expect(parseNumber('($3.10)')).toBe(-3.1);
  });

  it('is null for text that does not start with a number', () => {
    expect(parseNumber('SPY')).toBeNull();
    expect(parseNumber('S00033-EN')).toBeNull();
    expect(parseNumber('Stocks')).toBeNull();
    expect(parseNumber('5 minutes after the open')).toBe(5);
    expect(parseNumber('10mins')).toBe(10);
  });
});

describe('parseDate', () => {
  it('reads the date formats tables print', () => {
    const nov18 = new Date(2026, 10, 18).getTime();
    expect(parseDate('Nov 18, 2026')).toBe(nov18);
    expect(parseDate('18 Nov 2026')).toBe(nov18);
    expect(parseDate('2026-11-18')).toBe(nov18);
    expect(parseDate('11/18/2026')).toBe(nov18);
    expect(parseDate('Nov 18, 2026, 10:31 AM')).toBe(nov18 + (10 * 60 + 31) * 60_000);
    expect(parseDate('Nov 18, 2026, 1:05 PM')).toBe(nov18 + (13 * 60 + 5) * 60_000);
    expect(parseDate('2026-11-18 14:00 ET')).toBe(nov18 + 14 * 3_600_000);
    expect(parseDate('Wed, Nov 18')).toBe(new Date(new Date().getFullYear(), 10, 18).getTime());
  });

  it('is null for text that only starts like a date', () => {
    expect(parseDate('Nov 18 earnings beat')).toBeNull();
    expect(parseDate('Stocks')).toBeNull();
    expect(parseDate('May fail')).toBeNull();
  });
});

describe('columnValues', () => {
  it('sorts a column of amounts as numbers, blanks as empty', () => {
    expect(columnValues(['+$4.88', '−$13.96', '—', null])).toEqual([4.88, -13.96, null, null]);
  });

  it('falls back to dates, then text', () => {
    expect(columnValues(['Nov 2, 2026', 'Oct 30, 2026'])).toEqual([
      new Date(2026, 10, 2).getTime(),
      new Date(2026, 9, 30).getTime(),
    ]);
    expect(columnValues(['SPY', '12'])).toEqual(['SPY', '12']);
  });

  it('treats dashes and n/a as blank', () => {
    expect(isBlank('—')).toBe(true);
    expect(isBlank(' n/a ')).toBe(true);
    expect(isBlank('-5')).toBe(false);
  });
});

describe('sortedOrder', () => {
  it('sorts the Contribution by strategy example by net P/L both ways', () => {
    const net = columnValues(['+$276.02', '+$230.94', '+$0.10', '−$3.12', '−$3,221.10']);
    expect(sortedOrder(net, 'asc')).toEqual([4, 3, 2, 1, 0]);
    expect(sortedOrder(net, 'desc')).toEqual([0, 1, 2, 3, 4]);
  });

  it('sorts numbered text naturally and keeps blanks last both ways', () => {
    const v = columnValues(['S00039-SD', '—', 'S00027-EN', 'S00100-SN']);
    expect(sortedOrder(v, 'asc')).toEqual([2, 0, 3, 1]);
    expect(sortedOrder(v, 'desc')).toEqual([3, 0, 2, 1]);
    expect(compareValues('ETFs', 'etfs', 'asc')).toBe(0);
  });

  it('keeps ties in their current order', () => {
    expect(sortedOrder(['Stocks', 'ETFs', 'Stocks', 'ETFs'], 'asc')).toEqual([1, 3, 0, 2]);
  });
});

describe('nextSort / parseSort', () => {
  it('cycles low to high, high to low, then the list order', () => {
    const a = nextSort(null, 2);
    expect(a).toEqual({ col: 2, dir: 'asc' });
    const b = nextSort(a, 2);
    expect(b).toEqual({ col: 2, dir: 'desc' });
    expect(nextSort(b, 2)).toBeNull();
    expect(nextSort(b, 0)).toEqual({ col: 0, dir: 'asc' });
  });

  it('reads back only a real sort', () => {
    expect(parseSort('{"col":3,"dir":"desc"}')).toEqual({ col: 3, dir: 'desc' });
    expect(parseSort('{"col":-1,"dir":"desc"}')).toBeNull();
    expect(parseSort('nope')).toBeNull();
    expect(parseSort(null)).toBeNull();
  });
});
