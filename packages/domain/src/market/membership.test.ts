import { describe, expect, it } from 'vitest';
import { SP500_HISTORY_PERIODS } from './groups/sp500-history';
import {
  currentSymbolFor,
  membersOn,
  SP500_PERIODS,
  SYMBOL_RENAMES,
  spanCovers,
  spanOverlaps,
} from './membership';
import { stockGroupSymbols } from './stock-groups';

const isMember = (symbol: string, date: string) => membersOn(SP500_PERIODS, date).includes(symbol);

describe('point-in-time S&P 500 membership (N324)', () => {
  it('C1: TSLA joined in December 2020, SIVB left in March 2023', () => {
    expect(isMember('TSLA', '2020-06-01')).toBe(false);
    expect(isMember('TSLA', '2021-06-01')).toBe(true);
    expect(isMember('SIVB', '2023-01-03')).toBe(true);
    expect(isMember('SIVB', '2023-06-01')).toBe(false);
  });

  it('C2: about 500 members on 2019-06-03, and not today’s list', () => {
    const then = membersOn(SP500_PERIODS, '2019-06-03');
    expect(then.length).toBeGreaterThanOrEqual(490);
    expect(then.length).toBeLessThanOrEqual(510);
    const today = new Set(stockGroupSymbols('sp500'));
    expect(then.filter((s) => !today.has(s)).length).toBeGreaterThan(50);
  });

  it('periods of one symbol never overlap, and run forward', () => {
    const bySymbol = new Map<string, (typeof SP500_PERIODS)[number][]>();
    for (const p of SP500_PERIODS) bySymbol.set(p.symbol, [...(bySymbol.get(p.symbol) ?? []), p]);
    for (const list of bySymbol.values()) {
      list.sort((a, b) => a.from.localeCompare(b.from));
      for (let i = 0; i < list.length; i++) {
        const p = list[i]!;
        if (p.to !== null) expect(p.to > p.from).toBe(true);
        const next = list[i + 1];
        if (next) expect(p.to !== null && p.to <= next.from).toBe(true);
      }
    }
    expect(SP500_HISTORY_PERIODS.length).toBe(SP500_PERIODS.length);
  });

  it('every rename is a same-day swap in the file', () => {
    for (const r of SYMBOL_RENAMES) {
      expect(
        SP500_PERIODS.some((p) => p.symbol === r.from && p.to === r.on),
        r.from,
      ).toBe(true);
      expect(
        SP500_PERIODS.some((p) => p.symbol === r.to && p.from === r.on),
        r.to,
      ).toBe(true);
    }
  });

  it('a renamed company resolves to one symbol: FB and META, FISV and FI and FISV', () => {
    const of = (symbol: string, date: string) =>
      currentSymbolFor(SP500_PERIODS.find((p) => p.symbol === symbol && spanCovers(p, date))!);
    expect(of('FB', '2020-01-02')).toBe('META');
    expect(of('META', '2023-01-03')).toBe('META');
    expect(of('FISV', '2020-01-02')).toBe('FISV');
    expect(of('FI', '2024-01-02')).toBe('FISV');
    expect(of('SYMC', '2018-01-02')).toBe('GEN');
    expect(of('HCP', '2018-01-02')).toBe('DOC');
    expect(of('SIVB', '2023-01-03')).toBe('SIVB');
  });

  it('a symbol another company used before stays apart', () => {
    const oldDd = SP500_PERIODS.find((p) => p.symbol === 'DD' && p.to === '2017-09-01')!;
    expect(currentSymbolFor(oldDd)).toBeUndefined();
    const newDd = SP500_PERIODS.find((p) => p.symbol === 'DD' && p.from === '2019-06-03')!;
    expect(currentSymbolFor(newDd)).toBe('DD');
  });

  it('spans overlap a range when any day falls in it', () => {
    const s = { from: '2020-12-21', to: '2021-03-01' };
    expect(spanOverlaps(s, '2021-01-01', '2021-12-31')).toBe(true);
    expect(spanOverlaps(s, '2021-03-01', '2021-12-31')).toBe(false);
    expect(spanOverlaps({ from: '2020-12-21', to: null }, '2030-01-01', '2030-02-01')).toBe(true);
  });
});
