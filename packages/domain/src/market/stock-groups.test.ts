import { describe, expect, it } from 'vitest';
import { BUILTIN_UNIVERSES, groupUniverseSchema } from '../strategy/schema';
import { SP500_SECTORS } from './sp500';
import {
  isStockGroupId,
  SP500_SECTOR_GROUPS,
  STOCK_GROUP_IDS,
  STOCK_GROUPS,
  STOCK_SECTORS,
  stockGroup,
  stockGroupSymbols,
} from './stock-groups';

describe('built-in stock groups (ADR 0080)', () => {
  it('lists every id once, in picker order, as the strategy builder’s built-in universes', () => {
    expect(new Set(STOCK_GROUP_IDS).size).toBe(STOCK_GROUP_IDS.length);
    expect(STOCK_GROUPS.map((g) => g.id)).toEqual([...STOCK_GROUP_IDS]);
    expect(BUILTIN_UNIVERSES).toBe(STOCK_GROUP_IDS);
    for (const id of STOCK_GROUP_IDS)
      expect(groupUniverseSchema.safeParse({ type: 'builtin', id }).success).toBe(true);
    expect(groupUniverseSchema.safeParse({ type: 'builtin', id: 'ftse100' }).success).toBe(false);
  });

  it('keeps the S&P 500 group as before', () => {
    expect(stockGroup('sp500').label).toBe('S&P 500');
    expect(stockGroupSymbols('sp500')).toEqual([...SP500_SECTORS.keys()].sort());
  });

  it('splits the S&P 500 into its eleven sectors without losing a member', () => {
    expect(SP500_SECTOR_GROUPS).toHaveLength(11);
    const sectors = SP500_SECTOR_GROUPS.map(([id]) => stockGroup(id));
    const total = sectors.reduce((n, g) => n + g.members.size, 0);
    expect(total).toBe(SP500_SECTORS.size);
    for (const g of sectors) {
      expect(g.members.size).toBeGreaterThan(0);
      expect(g.label.startsWith('S&P 500 · ')).toBe(true);
    }
    expect(stockGroup('sp500_tech').members.has('AAPL')).toBe(true);
  });

  it('has lists of the expected sizes once refreshed', () => {
    const sizes: Record<string, [number, number]> = {
      ndx: [95, 110],
      dji: [30, 30],
      sp400: [380, 420],
      sp600: [570, 630],
      r1000: [950, 1060],
      r2000: [1850, 2100],
    };
    for (const [id, [min, max]] of Object.entries(sizes)) {
      if (!isStockGroupId(id)) throw new Error(id);
      const g = stockGroup(id);
      if (!g.asOf) continue;
      expect(g.members.size, id).toBeGreaterThanOrEqual(min);
      expect(g.members.size, id).toBeLessThanOrEqual(max);
      for (const s of g.members) expect(s).toMatch(/^[A-Z][A-Z0-9.]{0,9}$/);
    }
  });

  it('gives S&P 500 members their GICS sector first', () => {
    for (const [symbol, sector] of SP500_SECTORS) expect(STOCK_SECTORS.get(symbol)).toBe(sector);
    expect(isStockGroupId('all')).toBe(false);
  });
});
