import { describe, expect, it } from 'vitest';
import { formatMoney, formatPct, formatSignedMoney } from './backtest-text';
import { formatPrice } from './order-text';
import { formatCell } from './screener';

/** N284: every dollar amount carries "$" and every percentage "%" on the value itself. */
describe('units on the value (N284)', () => {
  it('dollar amounts carry $', () => {
    expect(formatSignedMoney(-1081.98)).toBe('−$1,081.98');
    expect(formatSignedMoney(0.1)).toBe('+$0.10');
    expect(formatMoney(304.64)).toBe('$304.64');
    expect(formatPrice('123.4')).toBe('$123.40');
    expect(formatPrice('-2')).toBe('−$2.00');
    expect(formatCell(12.3, 'price')).toBe('$12.30');
    expect(formatCell(1.2e9, 'money')).toBe('$1.2B');
  });

  it('percentages carry %', () => {
    expect(formatPct('-2.8', true)).toBe('−2.8%');
    expect(formatPct('0.03', true)).toBe('+0.03%');
    expect(formatCell(2.5, 'pct')).toBe('+2.50%');
  });

  it('a missing value stays a dash', () => {
    expect(formatPrice(null)).toBe('—');
    expect(formatPct(null)).toBe('—');
    expect(formatCell(null, 'price')).toBe('—');
  });
});
