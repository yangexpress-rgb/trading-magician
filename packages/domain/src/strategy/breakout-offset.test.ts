import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { highest } from '../market/indicators';
import { getIndicator } from './catalog';
import { comparison, context, indicator, market, validDefinition } from './test-fixtures';
import { validateStrategy } from './validate';

/** Design v1.2 item 7: the window of HIGHEST / LOWEST and the never-firing breakout. */
describe('HIGHEST / LOWEST window (v1.2 item 7)', () => {
  it('includes the current bar at Bars ago 0, so a close can never exceed it', () => {
    // Bars 1–20 have highs of at most 110; bar 21 closes at 115 with a high of 116.
    const highs = [...Array.from({ length: 20 }, (_, i) => 100 + (i % 10)), 116].map(
      (h) => new Decimal(h),
    );
    const window = highest(highs, 20);
    // Window ending on bar 21 (Bars ago 0) contains bar 21's own high.
    expect(window[20]?.toNumber()).toBe(116);
    // Window ending one bar earlier (Bars ago 1): bars 1–20, so 115 > 109 fires.
    expect(window[19]?.toNumber()).toBe(109);
    expect(new Decimal(115).gt(window[19]!)).toBe(true);
    expect(new Decimal(115).gt(window[20]!)).toBe(false);
  });

  it('starts one bar back in the builder, with help text saying which bars count', () => {
    for (const name of ['HIGHEST', 'LOWEST']) {
      const spec = getIndicator(name);
      expect(spec?.builderOffset).toBe(1);
      expect(spec?.help).toMatch(/Bars ago 1 \(the default\) the current bar is left out/);
    }
    expect(getIndicator('SMA')?.builderOffset).toBeUndefined();
  });

  const breakout = (offset: number, field: 'close' | 'high' = 'close') => {
    const def = validDefinition();
    def.entry.condition.children = [
      comparison(
        'b',
        market('m', { field }),
        'gt',
        indicator('h', { name: 'HIGHEST', params: { period: 20 }, field: 'high', offset }),
      ),
    ];
    return validateStrategy(def, context()).warnings.map((w) => w.code);
  };

  it('warns that "close above HIGHEST(high, 20)" at Bars ago 0 can never be true', () => {
    expect(breakout(0)).toContain('breakout_includes_current_bar');
    expect(breakout(1)).not.toContain('breakout_includes_current_bar');
  });

  it('warns for "close below LOWEST(low, 10)" at Bars ago 0 too, and for the mirrored form', () => {
    const def = validDefinition();
    const low = indicator('l', { name: 'LOWEST', params: { period: 10 }, field: 'low' });
    def.entry.condition.children = [comparison('b', low, 'gt', market('m'))];
    const v = validateStrategy(def, context());
    const w = v.warnings.find((x) => x.code === 'breakout_includes_current_bar');
    expect(w?.message).toMatch(/Set Lowest value's "Bars ago" to 1/);
    expect(v.errors).toEqual([]);
  });
});
