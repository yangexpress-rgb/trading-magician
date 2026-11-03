import { describe, expect, it } from 'vitest';
import {
  fromScreenTuple,
  screenRow,
  screenSession,
  toScreenTuple,
  type ScreenDay,
  type ScreenSource,
} from './screen';

/** Sessions 1..n with closes 100, 101, ... and volume 1,000 each. */
function days(n: number, last?: Partial<ScreenDay>): ScreenDay[] {
  const out: ScreenDay[] = [];
  for (let i = 0; i < n; i++) {
    const close = 100 + i;
    out.push({
      date: `2026-10-${String(i + 1).padStart(2, '0')}`,
      open: close - 0.5,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1000,
    });
  }
  if (last) Object.assign(out[out.length - 1]!, last);
  return out;
}

const source = (d: ScreenDay[], extra: Partial<ScreenSource> = {}): ScreenSource => ({
  symbol: 'ZTSTA',
  name: 'Test Alpha',
  assetClass: 'stock',
  exchange: 'NASDAQ',
  last: null,
  lastAt: null,
  days: d,
  ...extra,
});

describe('screen rows', () => {
  it('works out today against yesterday from the latest session', () => {
    const d = days(25, { open: 126, high: 130, low: 125, volume: 3000 });
    const row = screenRow(source(d, { last: 128.5, lastAt: '2026-10-25T18:00:00Z' }), '2026-10-25');
    // Yesterday closed at 123, the day before at 122.
    expect(row.prevClose).toBe(123);
    expect(row.last).toBe(128.5);
    expect(row.change).toBe(5.5);
    expect(row.changePct).toBe(4.47);
    expect(row.prevChangePct).toBe(0.82);
    expect(row.gapPct).toBe(2.44);
    expect(row.open).toBe(126);
    expect(row.volume).toBe(3000);
    expect(row.dollarVolume).toBe(385_500);
    expect(row.avgVolume20).toBe(1000);
    expect(row.relVolume).toBe(3);
    // Five sessions back from today is the close of 2026-10-20 (119).
    expect(row.change5dPct).toBe(pctOf(128.5, 119));
    expect(row.change1mPct).toBe(pctOf(128.5, 103));
    expect(row.high1m).toBe(130);
    expect(row.fromHigh1mPct).toBe(pctOf(128.5, 130));
    expect(row.lastAt).toBe('2026-10-25T18:00:00Z');
  });

  it('leaves today empty for a symbol that has not traded in the session', () => {
    const row = screenRow(source(days(10), { last: 109 }), '2026-10-11');
    expect(row.changePct).toBeNull();
    expect(row.open).toBeNull();
    expect(row.volume).toBeNull();
    expect(row.prevClose).toBe(109);
    expect(row.last).toBe(109);
    expect(row.prevChangePct).toBe(pctOf(109, 108));
  });

  it('uses the latest close when the feed has no trade', () => {
    const row = screenRow(source(days(3)), '2026-10-03');
    expect(row.last).toBe(102);
    expect(row.changePct).toBe(pctOf(102, 101));
    expect(row.change1mPct).toBeNull();
  });

  it('takes the latest session across symbols as today', () => {
    expect(screenSession([source(days(3)), source(days(5)), source([])])).toBe('2026-10-05');
    expect(screenSession([])).toBeNull();
  });

  it('round-trips through the wire tuple', () => {
    const row = screenRow(source(days(25), { last: 125 }), '2026-10-25');
    expect(fromScreenTuple(toScreenTuple(row))).toEqual(row);
  });
});

function pctOf(to: number, from: number) {
  return Math.round(((to - from) / from) * 10000) / 100;
}
