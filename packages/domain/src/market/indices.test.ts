import { describe, expect, it } from 'vitest';
import {
  cboeBars,
  findIndexListing,
  indexListingBySymbol,
  isIndicatorOnlyClass,
  parseCboeHistory,
  parseFredSeries,
} from './indices';

const CSV = `DATE,OPEN,HIGH,LOW,CLOSE
01/02/1990,17.24,17.24,17.24,17.24
03/28/2024,13.10,13.20,12.60,13.01
03/29/2024,13.00,13.10,12.90,13.05
04/01/2024,13.30,13.90,13.05,13.65
not a date,1,1,1,1
04/02/2024,14.10,14.80,13.90,14.61
04/02/2024,14.10,14.80,13.90,14.62
`;

describe('CBOE history (v1.2 item 5)', () => {
  it('reads MM/DD/YYYY rows, skips what does not parse and keeps the later duplicate', () => {
    const { days, skipped } = parseCboeHistory(CSV);
    expect(skipped).toBe(1);
    expect(days.map((d) => d.date)).toEqual([
      '1990-01-02',
      '2024-03-28',
      '2024-03-29',
      '2024-04-01',
      '2024-04-02',
    ]);
    expect(days.at(-1)?.close).toBe('14.62');
  });

  it('aligns bars to NYSE sessions and leaves out Good Friday', () => {
    const { days } = parseCboeHistory(CSV);
    const { bars, dropped } = cboeBars(days, '2024-01-01', '2024-12-31', new Date('2024-05-01'));
    expect(dropped).toEqual(['2024-03-29']);
    expect(bars.map((b) => b.end)).toEqual([
      '2024-03-28T20:00:00.000Z',
      '2024-04-01T20:00:00.000Z',
      '2024-04-02T20:00:00.000Z',
    ]);
    expect(bars[0]?.start).toBe('2024-03-28T13:30:00.000Z');
    expect(bars.every((b) => b.volume.isZero())).toBe(true);
  });

  it('gives no bar for a session that has not closed yet', () => {
    const { days } = parseCboeHistory(CSV);
    const { bars } = cboeBars(days, '2024-04-02', '2024-04-02', new Date('2024-04-02T18:00:00Z'));
    expect(bars).toEqual([]);
  });

  it('finds the VIX by symbol or name, and never a VIX-futures ETF', () => {
    expect(findIndexListing('vix')?.symbol).toBe('VIX');
    expect(findIndexListing('CBOE Volatility Index')?.symbol).toBe('VIX');
    expect(findIndexListing('VIXY')).toBeUndefined();
    expect(findIndexListing('UVXY')).toBeUndefined();
    expect(findIndexListing('Apple')).toBeUndefined();
    expect(isIndicatorOnlyClass('index')).toBe(true);
    expect(isIndicatorOnlyClass('etf')).toBe(false);
  });

  it('refuses impossible candles: a high below the close, a low above the open', () => {
    const { days, skipped } = parseCboeHistory(`DATE,OPEN,HIGH,LOW,CLOSE
04/01/2024,13.30,13.90,13.05,13.65
04/02/2024,14.10,14.00,13.90,14.61
04/03/2024,14.10,14.80,14.20,14.61
04/04/2024,14.10,14.80,13.90,13.95
04/08/2024,14.10,14.80,13.90,13.80
04/05/2024,14.10,13.90,14.00,14.00
`);
    expect(days.map((d) => d.date)).toEqual(['2024-04-01', '2024-04-04']);
    expect(skipped).toBe(4);
  });

  it("reads FRED's VIXCLS closes as flat bars, a blank or '.' day being no bar", () => {
    const { days, skipped } = parseFredSeries(`observation_date,VIXCLS
2024-03-28,13.01
2024-03-29,
2024-04-01,.
2024-04-02,14.61
garbage,1
`);
    expect(days).toEqual([
      { date: '2024-03-28', open: '13.01', high: '13.01', low: '13.01', close: '13.01' },
      { date: '2024-04-02', open: '14.61', high: '14.61', low: '14.61', close: '14.61' },
    ]);
    expect(skipped).toBe(1);
    expect(parseFredSeries('DATE,VIXCLS\n2024-03-28,13.01\n').days).toHaveLength(1);
    expect(() => parseFredSeries('nothing')).toThrow();
  });

  it("flags the VIX's Cboe display terms as not yet reviewed, with FRED as its fallback", () => {
    const vix = indexListingBySymbol('VIX');
    expect(vix?.fredSeries).toBe('VIXCLS');
    expect(vix?.terms).toMatchObject({ owner: 'Cboe Global Markets', reviewed: false });
  });
});
