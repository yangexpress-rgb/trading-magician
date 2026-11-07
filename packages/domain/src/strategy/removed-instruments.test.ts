import { describe, expect, it } from 'vitest';
import { DEMO_VENUE_CODE } from '../integrations/providers';
import { context, STOCK_A, STOCK_B, validDefinition } from './test-fixtures';
import { validateStrategy } from './validate';

/** Design v1.2 item 10: a strategy on a removed demo instrument is invalid and says so. */
describe('removed demo instruments', () => {
  const demoContext = (removed: boolean) => {
    const ctx = context({ demoInstrumentsRemoved: removed });
    const instruments = new Map(ctx.instruments);
    instruments.set(STOCK_A, { ...instruments.get(STOCK_A)!, venue: DEMO_VENUE_CODE });
    instruments.set(STOCK_B, {
      symbol: 'AAPL',
      assetClass: 'stock',
      lotSize: '1',
      venue: 'NASDAQ',
    });
    return { ...ctx, instruments };
  };

  it('names the removed instrument, once, when demo data is off', () => {
    const v = validateStrategy(validDefinition(), demoContext(true));
    const removed = v.errors.filter((e) => e.code === 'removed_instrument');
    expect(removed).toHaveLength(1);
    expect(removed[0]!.message).toMatch(/references a removed instrument \(DEMO-A\)/);
  });

  it('is not raised where demo data is on (tests)', () => {
    const v = validateStrategy(validDefinition(), demoContext(false));
    expect(v.errors.map((e) => e.code)).not.toContain('removed_instrument');
  });

  it('says a leg whose instrument no longer exists references a removed instrument', () => {
    const ctx = context();
    const instruments = new Map(ctx.instruments);
    instruments.delete(STOCK_A);
    const v = validateStrategy(validDefinition(), { ...ctx, instruments });
    expect(v.errors.find((e) => e.code === 'unknown_instrument')?.message).toMatch(
      /references a removed instrument/,
    );
  });
});
