import { describe, expect, it } from 'vitest';
import { formatMoney, formatPct, formatSignedMoney } from './backtest-text';
import { bare } from './units';

describe('bare (units in the header, O102)', () => {
  it('drops the currency symbol and percent sign, keeping digits, decimals and sign', () => {
    expect(bare(formatSignedMoney(1234.5))).toBe('+1,234.50');
    expect(bare(formatSignedMoney(-20))).toBe('−20.00');
    expect(bare(formatMoney(0))).toBe('0.00');
    expect(bare(formatPct('24.93', true))).toBe('+24.93');
    expect(bare(formatPct('-3.1'))).toBe('−3.1');
    expect(bare('$1.2B')).toBe('1.2B');
  });

  it('leaves a missing value and text alone', () => {
    expect(bare('—')).toBe('—');
    expect(bare(formatPct(null))).toBe('—');
    expect(bare('Not reported')).toBe('Not reported');
    expect(bare('$20 a month')).toBe('$20 a month');
  });
});

describe('screener headers carry the unit', () => {
  it('adds $ or % once', async () => {
    const { columnHeader, formatCell } = await import('./screener');
    expect(columnHeader({ label: 'Last price', format: 'price' })).toBe('Last price $');
    expect(columnHeader({ label: 'Market cap', format: 'money' })).toBe('Market cap $');
    expect(columnHeader({ label: 'Today’s $ volume', format: 'money' })).toBe('Today’s $ volume');
    expect(columnHeader({ label: '5-day change %', format: 'pct' })).toBe('5-day change %');
    expect(columnHeader({ label: 'P/E', format: 'ratio' })).toBe('P/E');
    expect(bare(formatCell(2.5, 'pct'))).toBe('+2.50');
    expect(bare(formatCell(1.2e9, 'money'))).toBe('1.2B');
  });
});
