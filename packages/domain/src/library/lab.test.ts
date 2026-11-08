import { describe, expect, it } from 'vitest';
import { CONTEXT_INSTRUMENT_ID } from '../strategy/evaluate';
import type { StrategyDefinition } from '../strategy/schema';
import {
  comparison,
  indicator,
  market,
  order,
  STOCK_A,
  STOCK_B,
  validDefinition,
} from '../strategy/test-fixtures';
import { formatDuration } from './duration';
import {
  autoCreatedRecord,
  deriveLibraryCodes,
  deriveTimeframeCode,
  isFixtureName,
  type LabAssetClass,
} from './lab';
import { registerLibraryEntrySchema } from './entry';

const ETF_A = '00000000-0000-4000-8000-0000000000e1';
const OPTION = '00000000-0000-4000-8000-0000000000c1';
const VIX = '00000000-0000-4000-8000-0000000000d1';
const CLASSES: Record<string, LabAssetClass> = {
  [STOCK_A]: 'stock',
  [STOCK_B]: 'stock',
  [ETF_A]: 'etf',
  [OPTION]: 'option',
  [VIX]: 'index',
};
const classOf = (id: string) => CLASSES[id];
const SYMBOLS: Record<string, string> = {
  [STOCK_A]: 'DEMO-A',
  [STOCK_B]: 'DEMO-B',
  [ETF_A]: 'SPY',
};

function withLegs(...instrumentIds: string[]): StrategyDefinition {
  const def = validDefinition();
  def.entry.orders = instrumentIds.map((id, i) => order(`buy-${i}`, { instrumentId: id }));
  return def;
}

describe('letters for an auto-created record (brief D4)', () => {
  it('takes the one asset class traded, A for more than one, and ignores watch-only indices', () => {
    expect(deriveLibraryCodes(withLegs(STOCK_A, STOCK_B), classOf)).toEqual({
      recordTypeCode: 'S',
      timeframeCode: 'D',
      assetClassCode: 'S',
    });
    expect(deriveLibraryCodes(withLegs(ETF_A), classOf)?.assetClassCode).toBe('E');
    expect(deriveLibraryCodes(withLegs(OPTION), classOf)?.assetClassCode).toBe('O');
    expect(deriveLibraryCodes(withLegs(STOCK_A, ETF_A), classOf)?.assetClassCode).toBe('A');
    // A VIX condition doesn't make a stock strategy multi-asset.
    const vix = withLegs(STOCK_A);
    vix.entry.condition.children = [
      comparison(
        'v',
        market('vm', { instrumentId: VIX }),
        'gt',
        indicator('vi', { instrumentId: VIX }),
      ),
    ];
    expect(deriveLibraryCodes(vix, classOf)?.assetClassCode).toBe('S');
  });

  it('issues nothing while no Entry leg has an instrument (D3)', () => {
    const def = validDefinition();
    def.entry.orders = [];
    expect(deriveLibraryCodes(def, classOf)).toBeNull();
    // Unknown instruments are not guessed either.
    expect(
      deriveLibraryCodes(withLegs('00000000-0000-4000-8000-0000000000ff'), classOf),
    ).toBeNull();
  });

  it('reads a Selection group by its universe: S&P 500 is stocks, a list takes its classes', () => {
    const sp = withLegs(CONTEXT_INSTRUMENT_ID);
    sp.entry.kind = 'selection';
    sp.entry.selection = {
      universe: { type: 'builtin', id: 'sp500' },
      ranking: { metric: 'return', params: { lookback: 126 } },
      direction: 'desc',
      count: { type: 'fixed', value: 3 },
    };
    expect(deriveLibraryCodes(sp, classOf)?.assetClassCode).toBe('S');
    const list: StrategyDefinition = {
      ...sp,
      entry: {
        ...sp.entry,
        selection: { ...sp.entry.selection!, universe: { type: 'list', instrumentIds: [ETF_A] } },
      },
    };
    expect(deriveLibraryCodes(list, classOf)?.assetClassCode).toBe('E');
    const mixed: StrategyDefinition = {
      ...sp,
      entry: {
        ...sp.entry,
        selection: {
          ...sp.entry.selection!,
          universe: { type: 'list', instrumentIds: [ETF_A, STOCK_A] },
        },
      },
    };
    expect(deriveLibraryCodes(mixed, classOf)?.assetClassCode).toBe('A');
  });

  it('takes the timescale from the schedule first (O73), then the bars, D when unclear', () => {
    const def = withLegs(STOCK_A);
    expect(deriveTimeframeCode(def)).toBe('D');
    expect(deriveTimeframeCode({ ...def, schedule: { frequency: 'monthEnd' } })).toBe('M');
    expect(deriveTimeframeCode({ ...def, schedule: { frequency: 'quarterEnd' } })).toBe('Q');
    expect(deriveTimeframeCode({ ...def, schedule: { frequency: 'yearEnd' } })).toBe('Y');
    expect(deriveTimeframeCode({ ...def, schedule: { frequency: 'weekly' } })).toBe('W');
    expect(deriveTimeframeCode({ ...def, schedule: { frequency: 'daily' } })).toBe('D');

    const bars = (...intervals: ('5m' | '1h' | '1d' | '1w')[]) => {
      const d = withLegs(STOCK_A);
      d.entry.condition.children = intervals.map((interval, i) =>
        comparison(`c${i}`, market(`m${i}`, { interval }), 'gt', indicator(`i${i}`, { interval })),
      );
      d.exit.condition.children = [];
      return d;
    };
    expect(deriveTimeframeCode(bars('5m'))).toBe('N');
    expect(deriveTimeframeCode(bars('1h'))).toBe('H');
    expect(deriveTimeframeCode(bars('1w'))).toBe('W');
    expect(deriveTimeframeCode(bars('5m', '1d'))).toBe('D');
    expect(deriveTimeframeCode({ ...bars('5m'), schedule: { frequency: 'monthEnd' } })).toBe('M');
  });
});

describe('the auto-created record (brief D3)', () => {
  it('is a valid registration made from the strategy', () => {
    const def = withLegs(STOCK_A, STOCK_B);
    def.groups = [
      {
        id: 'g2',
        label: 'Short leg',
        entry: {
          ...def.entry,
          orders: [order('short', { side: 'sell_short', instrumentId: STOCK_B })],
        },
        exit: def.exit,
      },
    ];
    const record = autoCreatedRecord({
      strategyId: '00000000-0000-4000-8000-000000000123',
      name: 'Two stocks',
      description: '',
      definition: def,
      symbol: (id) => SYMBOLS[id],
      classOf,
    })!;
    const parsed = registerLibraryEntrySchema.parse(record);
    expect(parsed).toMatchObject({
      name: 'Two stocks',
      category: 'other',
      tags: ['auto-created'],
      timeframeCode: 'D',
      assetClassCode: 'S',
      assets: 'DEMO-A, DEMO-B',
      shortDescription: 'Auto-created from the Strategy Lab strategy “Two stocks”.',
      dataRequirements: 'Auto-created from Strategy Lab — complete in the Library.',
      builtStrategyId: '00000000-0000-4000-8000-000000000123',
    });
    expect(parsed.entry).toBe(
      'DEMO-A close crosses above SMA(20) of DEMO-A close\n\nShort leg:\n- DEMO-A close crosses above SMA(20) of DEMO-A close',
    );
    expect(parsed.exit.startsWith('DEMO-A close < 95')).toBe(true);
    expect(formatDuration(parsed.frequency)).toBe('1 day');
  });

  it('is null for a draft with nothing to trade', () => {
    const def = validDefinition();
    def.entry.orders = [];
    expect(
      autoCreatedRecord({
        strategyId: '00000000-0000-4000-8000-000000000123',
        name: 'Empty',
        description: '',
        definition: def,
        symbol: () => undefined,
        classOf,
      }),
    ).toBeNull();
  });

  it('knows a fixture by its name (O74)', () => {
    expect(isFixtureName('Fixture 1 — Sector rotation top 3')).toBe(true);
    expect(isFixtureName('fixture')).toBe(true);
    expect(isFixtureName('Fixtures and fittings')).toBe(false);
    expect(isFixtureName('Sector rotation')).toBe(false);
  });
});
