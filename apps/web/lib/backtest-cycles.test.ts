import type { BacktestFill, BacktestOrder, ConditionBar, PhaseConditionReport } from '@tm/backtest';
import type { BacktestRunDto, BacktestTradeDto } from '@tm/contracts';
import { describe, expect, it } from 'vitest';
import {
  buildCycles,
  cycleCounts,
  cyclesCsv,
  matchesFilter,
  matchesSearch,
  skippedSignals,
  sortCycles,
} from './backtest-cycles';

type Result = NonNullable<BacktestRunDto['result']>;

const A = 'inst-a';
const day = (d: string, h = 20) => `2023-${d}T${String(h).padStart(2, '0')}:00:00.000Z`;

const order = (p: Partial<BacktestOrder>): BacktestOrder => ({
  cycle: 1,
  phase: 'entry',
  legId: 'buy-a',
  legLabel: 'Buy A',
  instrumentId: A,
  symbol: 'DEMO-A',
  side: 'buy',
  orderType: 'market',
  timeInForce: 'day',
  outcome: 'filled',
  reason: null,
  detail: {},
  decidedAt: null,
  activeFrom: null,
  endedAt: null,
  quantity: '20',
  limitPrice: null,
  stopPrice: null,
  referencePrice: null,
  filledQuantity: '20',
  averagePrice: null,
  fills: 1,
  barsWorking: 0,
  bestPrice: null,
  ...p,
});

const fill = (p: Partial<BacktestFill>): BacktestFill => ({
  time: day('01-01'),
  cycle: 1,
  legId: 'buy-a',
  legLabel: 'Buy A',
  phase: 'entry',
  instrumentId: A,
  symbol: 'DEMO-A',
  side: 'buy',
  quantity: '20',
  price: '100',
  commission: '0',
  slippage: '0',
  ...p,
});

const bar = (time: string, p: Partial<ConditionBar> = {}): ConditionBar => ({
  time,
  truth: false,
  checks: [],
  ...p,
});

const report = (bars: ConditionBar[]): PhaseConditionReport => ({
  condition: { kind: 'group', id: 'g', op: 'and', negate: false, children: [] },
  evaluated: bars.length,
  trueBars: 0,
  falseBars: 0,
  unknownBars: 0,
  fired: 0,
  comparisons: [],
  bars,
  barsTruncated: false,
});

const trade = (p: Partial<BacktestTradeDto>): BacktestTradeDto => ({
  cycle: 1,
  status: 'closed',
  entryTime: day('01-13', 14),
  exitTime: day('02-06', 14),
  grossPnl: '27.2',
  costs: '0.03',
  netPnl: '27.17',
  returnPct: '0.84',
  legs: [],
  ...p,
});

// The DEMO-A run from the screenshot: cycle 1 closed at a gain, cycle 2 at a
// loss, cycle 3 pending at the end of the test.
function demo(withCycleLinks: boolean): { result: Result; trades: BacktestTradeDto[] } {
  const orders = [
    order({ cycle: 1, decidedAt: day('01-12'), endedAt: day('01-13', 14), averagePrice: '160.82' }),
    order({
      cycle: 1,
      phase: 'exit',
      legId: 'close-a',
      legLabel: 'Close A',
      side: 'sell',
      decidedAt: day('02-03'),
      endedAt: day('02-06', 14),
      averagePrice: '162.18',
    }),
    order({ cycle: 2, decidedAt: day('02-21'), endedAt: day('02-22', 14), averagePrice: '165.70' }),
    order({
      cycle: 2,
      phase: 'exit',
      legId: 'close-a',
      legLabel: 'Close A',
      side: 'sell',
      decidedAt: day('02-22'),
      endedAt: day('02-23', 14),
      averagePrice: '162.26',
    }),
    order({
      cycle: 3,
      decidedAt: day('03-31'),
      outcome: 'working_at_end',
      filledQuantity: '0',
    }),
  ];
  const link = (n: number) => (withCycleLinks ? { cycle: n } : {});
  const entryBars = [
    bar(day('01-11')),
    bar(day('01-12'), { truth: true, outcome: 'fired', ...link(1) }),
    bar(day('02-21'), { truth: true, outcome: 'fired', ...link(2) }),
    bar(day('02-22'), { truth: true, outcome: 'cycle_open' }),
    bar(day('03-31'), { truth: true, outcome: 'fired', ...link(3) }),
  ];
  const exitBars = [
    bar(day('01-13'), { cycle: 1 }),
    bar(day('02-03'), { cycle: 1, truth: true, outcome: 'fired' }),
    bar(day('02-22'), { cycle: 2, truth: true, outcome: 'fired' }),
  ];
  const fills = [
    fill({ cycle: 1, price: '160.82', commission: '0.01', slippage: '0.01' }),
    fill({ cycle: 1, phase: 'exit', side: 'sell', price: '162.18', commission: '0.01' }),
    fill({ cycle: 2, price: '165.70' }),
    fill({ cycle: 2, phase: 'exit', side: 'sell', price: '162.26', commission: '0.08' }),
  ];
  const result = {
    conditions: { entry: report(entryBars), exit: report(exitBars) },
    orders,
    fills,
    symbols: { [A]: 'DEMO-A' },
    contributions: [],
    warnings: [],
    equity: [],
    assumptions: [],
    sharpeMethod: '',
    engineVersion: 'engine@1',
    dataVersions: [],
    ...(withCycleLinks
      ? {
          cycles: [
            {
              cycle: 1,
              instruments: [
                {
                  instrumentId: A,
                  symbol: 'DEMO-A',
                  grossPnl: '27.2',
                  costs: '0.03',
                  netPnl: '27.17',
                },
              ],
            },
            {
              cycle: 2,
              instruments: [
                {
                  instrumentId: A,
                  symbol: 'DEMO-A',
                  grossPnl: '-68.8',
                  costs: '0.08',
                  netPnl: '-68.88',
                },
              ],
            },
          ],
        }
      : {}),
  } as Result;
  const trades = [
    trade({}),
    trade({
      cycle: 2,
      entryTime: day('02-22', 14),
      exitTime: day('02-23', 14),
      grossPnl: '-68.8',
      costs: '0.08',
      netPnl: '-68.88',
      returnPct: '-2.08',
    }),
  ];
  return { result, trades };
}

describe('buildCycles', () => {
  for (const linked of [true, false]) {
    it(`gathers each cycle's Entry, Exit, orders and legs (${linked ? 'new run' : 'older run'})`, () => {
      const { result, trades } = demo(linked);
      const cycles = buildCycles(result, trades);
      expect(cycles.map((c) => [c.cycle, c.status])).toEqual([
        [1, 'closed'],
        [2, 'closed'],
        [3, 'pending'],
      ]);
      const [c1, c2, c3] = cycles;
      expect(c1!.entry.bar?.time).toBe(day('01-12'));
      expect(c1!.exit.bars.map((b) => b.time)).toEqual([day('01-13'), day('02-03')]);
      expect(c1!.exit.bar?.time).toBe(day('02-03'));
      expect(c1!.exit.decidedAt).toBe(day('02-03'));
      expect(c1!.heldDays).toBe(24);
      expect(c1!.exitReason).toBe('condition');
      expect(c1!.legs).toEqual([
        {
          instrumentId: A,
          symbol: 'DEMO-A',
          entryLabels: ['Buy A'],
          exitLabels: ['Close A'],
          quantity: '20',
          entryPrice: '160.82',
          exitPrice: '162.18',
          grossPnl: linked ? '27.2' : '27.21',
          costs: linked ? '0.03' : '0.03',
          netPnl: linked ? '27.17' : '27.18',
        },
      ]);
      expect(c2!.legs[0]!.netPnl).toBe(linked ? '-68.88' : '-68.88');
      // Pending: in the orders but not the trades.
      expect(c3!.trade).toBeNull();
      expect(c3!.entry.bar?.time).toBe(day('03-31'));
      expect(c3!.legs[0]).toMatchObject({ quantity: null, entryPrice: null, netPnl: null });
      expect(c3!.net).toBeNull();
    });
  }

  it('finds the selection round that picked a cycle', () => {
    const { result, trades } = demo(true);
    result.selections = {
      kind: 'ranking',
      metric: null,
      direction: 'desc',
      schedule: 'daily',
      exclusionLabels: {},
      rounds: [
        {
          time: day('01-12'),
          period: '2023-01-12',
          rows: [
            ['DEMO-A', '0.05', true, 1, true, null],
            ['DEMO-B', '0.01', true, 2, false, 'top_n'],
          ],
          entered: ['DEMO-A'],
          exited: [],
        },
      ],
    };
    const [c1, c2] = buildCycles(result, trades);
    expect(c1!.round?.rows).toEqual([['DEMO-A', '0.05', true, 1, true, null]]);
    expect(c2!.round).toBeNull();
  });
});

describe('the cycle list', () => {
  const { result, trades } = demo(true);
  const cycles = buildCycles(result, trades);

  it('counts and filters by result and instrument', () => {
    expect(cycleCounts(cycles)).toMatchObject({
      all: 3,
      closed: 2,
      won: 1,
      lost: 1,
      unfinished: 1,
    });
    expect(cycleCounts(cycles).net).toBeCloseTo(-41.71);
    expect(cycles.filter((c) => matchesFilter(c, 'won')).map((c) => c.cycle)).toEqual([1]);
    expect(cycles.filter((c) => matchesFilter(c, 'lost')).map((c) => c.cycle)).toEqual([2]);
    expect(cycles.filter((c) => matchesFilter(c, 'unfinished')).map((c) => c.cycle)).toEqual([3]);
    expect(cycles.filter((c) => matchesSearch(c, 'demo-a'))).toHaveLength(3);
    expect(cycles.filter((c) => matchesSearch(c, 'NVDA'))).toHaveLength(0);
  });

  it('sorts the biggest loss first and the longest hold first, unfinished last', () => {
    expect(sortCycles(cycles, 'net').map((c) => c.cycle)).toEqual([2, 1, 3]);
    expect(sortCycles(cycles, 'held').map((c) => c.cycle)).toEqual([1, 2, 3]);
    expect(sortCycles(cycles, 'cycle').map((c) => c.cycle)).toEqual([1, 2, 3]);
  });

  it('counts Entry signals that did not open a cycle', () => {
    expect(skippedSignals(result)).toEqual({ cycle_open: 1 });
  });

  it('writes one CSV row per instrument per cycle', () => {
    const lines = cyclesCsv(cycles).trimEnd().split('\r\n');
    expect(lines[0]).toBe(
      'cycle,status,instrument,entry_legs,quantity,entry_decided,entry_filled,entry_price,exit_legs,exit_decided,exit_filled,exit_price,exit_reason,gross_pnl,costs,net_pnl',
    );
    expect(lines).toHaveLength(4);
    expect(lines[1]).toBe(
      `1,closed,DEMO-A,Buy A,20,${day('01-12')},${day('01-13', 14)},160.82,Close A,${day('02-03')},${day('02-06', 14)},162.18,condition,27.2,0.03,27.17`,
    );
    expect(lines[2]).toContain(',-68.88');
    expect(lines[3]).toMatch(/^3,pending,DEMO-A,Buy A,,/);
  });
});
