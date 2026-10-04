import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { quoteFill, volumeCap, type FillableOrder } from './fills';
import { dailyBars } from './test-utils';

const [bar] = dailyBars('2024-03-04', [[100, 105, 95, 102, 12_345]]);
if (!bar) throw new Error('no bar');
const bps = new Decimal(10);
const order = (o: Partial<FillableOrder>): FillableOrder => ({
  direction: 'buy',
  type: 'market',
  stopTriggered: false,
  ...o,
});
const px = (o: Partial<FillableOrder>) => {
  const q = quoteFill(order(o), bar, bps);
  return q && [q.base.toString(), q.price.toString()];
};

describe('fill model', () => {
  it('fills market orders at the open, slipped against the trader', () => {
    expect(px({})).toEqual(['100', '100.1']);
    expect(px({ direction: 'sell' })).toEqual(['100', '99.9']);
  });

  it('fills limits at the open when already better, else at the limit if touched', () => {
    expect(px({ type: 'limit', limit: new Decimal(101) })).toEqual(['100', '100']);
    expect(px({ type: 'limit', limit: new Decimal(97) })).toEqual(['97', '97']);
    expect(px({ type: 'limit', limit: new Decimal(94) })).toBeUndefined();
    expect(px({ type: 'limit', direction: 'sell', limit: new Decimal(104) })).toEqual([
      '104',
      '104',
    ]);
  });

  it('fills stops at the stop, or at the open after a gap', () => {
    expect(px({ type: 'stop', stop: new Decimal(103) })).toEqual(['103', '103.103']);
    expect(px({ type: 'stop', stop: new Decimal(99) })).toEqual(['100', '100.1']);
    expect(px({ type: 'stop', stop: new Decimal(106) })).toBeUndefined();
    expect(px({ type: 'stop', direction: 'sell', stop: new Decimal(96) })).toEqual([
      '96',
      '95.904',
    ]);
  });

  it('treats a triggered stop-limit as a limit', () => {
    expect(px({ type: 'stop_limit', stop: new Decimal(103), limit: new Decimal(104) })).toEqual([
      '103',
      '103',
    ]);
    // Triggers at 103 but the limit of 102 is only reachable below the trigger: still touched on the bar.
    expect(px({ type: 'stop_limit', stop: new Decimal(103), limit: new Decimal(102) })).toEqual([
      '102',
      '102',
    ]);
    expect(
      px({ type: 'stop_limit', stop: new Decimal(106), limit: new Decimal(107) }),
    ).toBeUndefined();
  });

  it('caps a fill at a share of the bar volume', () => {
    expect(volumeCap(bar, new Decimal(10)).toString()).toBe('1234');
  });
});
