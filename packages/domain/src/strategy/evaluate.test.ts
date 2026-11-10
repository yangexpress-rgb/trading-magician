import Decimal from 'decimal.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  evaluateComparison,
  evaluateCondition,
  evaluateExpr,
  type SeriesExpr,
  type SeriesResolver,
  type Truth,
  withPositions,
} from './evaluate';
import type { ConditionGroup, ConditionNode, Expr } from './schema';
import { comparison, constant, indicator, market, position, STOCK_A } from './test-fixtures';

/** Resolver backed by a table of series id → values, newest last. */
function resolver(
  series: Record<string, (number | undefined)[]>,
  stale: string[] = [],
): SeriesResolver {
  return {
    value(expr: SeriesExpr, barsBack: number) {
      const values = series[expr.id];
      if (!values) return undefined;
      const v = values[values.length - 1 - expr.offset - barsBack];
      return v === undefined ? undefined : new Decimal(v);
    },
    isStale: (expr) => stale.includes(expr.id),
  };
}

const calc = (op: Extract<Expr, { kind: 'calc' }>['op'], ...args: Expr[]): Expr => ({
  kind: 'calc',
  id: `calc-${op}`,
  op,
  args,
});

describe('expressions', () => {
  const r = resolver({ px: [99, 101], sma: [100, 100] });

  it('evaluates constants exactly', () => {
    expect(evaluateExpr(calc('add', constant('0.1'), constant('0.2')), r)?.toString()).toBe('0.3');
  });

  it('reads series values and offsets', () => {
    expect(evaluateExpr(market('px'), r)?.toNumber()).toBe(101);
    expect(evaluateExpr(market('px', { offset: 1 }), r)?.toNumber()).toBe(99);
    expect(evaluateExpr(market('px', { offset: 2 }), r)).toBeUndefined();
  });

  it.each([
    ['sub', [constant('5'), constant('3')], '2'],
    ['mul', [constant('1.5'), constant('4')], '6'],
    ['div', [constant('1'), constant('4')], '0.25'],
    ['neg', [constant('3')], '-3'],
    ['abs', [constant('-3')], '3'],
    ['min', [constant('3'), constant('1'), constant('2')], '1'],
    ['max', [constant('3'), constant('1'), constant('2')], '3'],
  ] as const)('computes %s', (op, args, expected) => {
    expect(evaluateExpr(calc(op, ...args), r)?.toString()).toBe(expected);
  });

  it('treats division by zero and missing inputs as unknown', () => {
    expect(evaluateExpr(calc('div', constant('1'), constant('0')), r)).toBeUndefined();
    expect(evaluateExpr(calc('add', market('missing'), constant('1')), r)).toBeUndefined();
  });
});

describe('comparisons', () => {
  const r = resolver({ px: [99, 101], sma: [100, 100], gap: [1, undefined] }, ['sma']);

  it.each([
    ['gt', '100', true],
    ['gte', '101', true],
    ['lt', '101', false],
    ['lte', '101', true],
    ['eq', '101', true],
    ['neq', '101', false],
  ] as const)('%s %s', (op, value, expected) => {
    expect(evaluateComparison(comparison('c', market('px'), op, constant(value)), r)).toBe(
      expected,
    );
  });

  it('detects crossings only on the bar they happen', () => {
    expect(
      evaluateComparison(comparison('c', market('px'), 'crosses_above', indicator('sma')), r),
    ).toBe(true);
    expect(
      evaluateComparison(comparison('c', market('px'), 'crosses_below', indicator('sma')), r),
    ).toBe(false);
    const later = resolver({ px: [99, 101, 102], sma: [100, 100, 100] });
    expect(
      evaluateComparison(comparison('c', market('px'), 'crosses_above', indicator('sma')), later),
    ).toBe(false);
  });

  it('needs the previous bar to detect a crossing', () => {
    const short = resolver({ px: [101], sma: [100] });
    expect(
      evaluateComparison(comparison('c', market('px'), 'crosses_above', indicator('sma')), short),
    ).toBeUndefined();
  });

  it('checks ranges inclusively', () => {
    const between = (lo: string, hi: string) =>
      evaluateComparison(comparison('c', market('px'), 'between', constant(lo), constant(hi)), r);
    expect(between('101', '105')).toBe(true);
    expect(between('90', '100')).toBe(false);
    expect(
      evaluateComparison(
        comparison('c', market('px'), 'outside', constant('90'), constant('100')),
        r,
      ),
    ).toBe(true);
  });

  it('reports data availability and staleness', () => {
    expect(evaluateComparison(comparison('c', market('gap'), 'is_available'), r)).toBe(false);
    expect(evaluateComparison(comparison('c', market('px'), 'is_available'), r)).toBe(true);
    expect(evaluateComparison(comparison('c', indicator('sma'), 'is_stale'), r)).toBe(true);
    expect(evaluateComparison(comparison('c', market('px'), 'is_stale'), r)).toBe(false);
  });

  it('is unknown when a side is missing', () => {
    expect(
      evaluateComparison(comparison('c', market('gap'), 'gt', constant('0')), r),
    ).toBeUndefined();
  });
});

describe('condition groups', () => {
  const r = resolver({ px: [101] });
  const t = comparison('t', market('px'), 'gt', constant('100'));
  const f = comparison('f', market('px'), 'lt', constant('100'));
  const u = comparison('u', market('missing'), 'gt', constant('0'));
  const group = (op: 'and' | 'or', children: ConditionNode[], negate = false): ConditionGroup => ({
    kind: 'group',
    id: 'g',
    op,
    negate,
    children,
  });

  it('never qualifies an empty group', () => {
    expect(evaluateCondition(group('and', []), r)).toBeUndefined();
  });

  it('uses three-valued logic', () => {
    expect(evaluateCondition(group('and', [t, u]), r)).toBeUndefined();
    expect(evaluateCondition(group('and', [f, u]), r)).toBe(false);
    expect(evaluateCondition(group('or', [t, u]), r)).toBe(true);
    expect(evaluateCondition(group('or', [f, u]), r)).toBeUndefined();
  });

  it('negates known results and leaves unknown alone', () => {
    expect(evaluateCondition(group('and', [t], true), r)).toBe(false);
    expect(evaluateCondition(group('and', [u], true), r)).toBeUndefined();
  });

  // Property: with every comparison known, the result matches plain Boolean logic.
  const leafArb = fc.boolean().map((b): ConditionNode => (b ? t : f));
  const { node: nodeArb } = fc.letrec<{ node: ConditionNode }>((tie) => ({
    node: fc.oneof(
      { depthSize: 'small', withCrossShrink: true },
      leafArb,
      fc
        .record({
          op: fc.constantFrom('and' as const, 'or' as const),
          negate: fc.boolean(),
          children: fc.array(tie('node'), { minLength: 1, maxLength: 4 }),
        })
        .map((g): ConditionNode => ({ kind: 'group', id: 'g', ...g })),
    ),
  }));
  const plain = (n: ConditionNode): boolean => {
    if (n.kind === 'comparison') return n === t;
    const vs = n.children.map(plain);
    const v = n.op === 'and' ? vs.every(Boolean) : vs.some(Boolean);
    return n.negate ? !v : v;
  };

  it('matches Boolean logic when all data is known', () => {
    fc.assert(
      fc.property(nodeArb, (n) => {
        expect(evaluateCondition(n, r)).toBe(plain(n));
      }),
      { numRuns: 300 },
    );
  });

  it('never turns unknown into true for an AND that contains it', () => {
    fc.assert(
      fc.property(fc.array(nodeArb, { maxLength: 4 }), (others) => {
        const result: Truth = evaluateCondition(group('and', [u, ...others]), r);
        expect(result).not.toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});

describe('position values', () => {
  // The mark series is the position's interval close; its id is the position's id.
  const held = (quantity: number, averagePrice: number, closes: number[]) =>
    withPositions(resolver({ pos: closes }), (id) =>
      id === STOCK_A
        ? { quantity: new Decimal(quantity), averagePrice: new Decimal(averagePrice) }
        : undefined,
    );

  it('measures gain from the average entry price at the latest close', () => {
    const r = held(10, 100, [101, 105]);
    expect(evaluateExpr(position('pos'), r)?.toString()).toBe('5');
    expect(evaluateExpr(position('pos', { field: 'entry_price' }), r)?.toString()).toBe('100');
    expect(evaluateExpr(position('pos', { field: 'pnl' }), r)?.toString()).toBe('50');
    expect(evaluateExpr(position('pos', { field: 'quantity' }), r)?.toString()).toBe('10');
  });

  it('counts a fall in price as a gain on a short', () => {
    const r = held(-10, 100, [95]);
    expect(evaluateExpr(position('pos'), r)?.toString()).toBe('5');
    expect(evaluateExpr(position('pos', { field: 'pnl' }), r)?.toString()).toBe('50');
  });

  it('is unknown without a position, so a take-profit cannot fire', () => {
    const flat = resolver({ pos: [200] });
    expect(evaluateExpr(position('pos'), flat)).toBeUndefined();
    expect(evaluateExpr(position('pos', { field: 'quantity' }), flat)?.toString()).toBe('0');
    expect(
      evaluateComparison(comparison('tp', position('pos'), 'gte', constant('5')), flat),
    ).toBeUndefined();
  });

  it('fires a 5% take-profit only once the close reaches it', () => {
    const tp = comparison('tp', position('pos'), 'gte', constant('5'));
    expect(evaluateComparison(tp, held(10, 100, [104.99]))).toBe(false);
    expect(evaluateComparison(tp, held(10, 100, [105]))).toBe(true);
  });

  it('reads off best close since entry, for a long and a short (N217)', () => {
    const at = (quantity: number, peak: number, close: number) =>
      withPositions(resolver({ pos: [close] }), (id) =>
        id === STOCK_A
          ? {
              quantity: new Decimal(quantity),
              averagePrice: new Decimal(100),
              peak: new Decimal(peak),
              peakClose: new Decimal(close),
            }
          : undefined,
      );
    const off = position('pos', { field: 'off_peak_pct' });
    expect(evaluateExpr(off, at(10, 120, 114))?.toString()).toBe('5');
    // A short's best close is its lowest; a rise above it reads as a positive amount off.
    expect(evaluateExpr(off, at(-10, 80, 84))?.toString()).toBe('5');
    // No peak yet (no Check Exit since Entry filled): unknown, so it cannot exit.
    expect(evaluateExpr(off, held(10, 100, [90]))).toBeUndefined();
  });

  it('reports the mark series as stale', () => {
    const r = withPositions(resolver({ pos: [100] }, ['pos']), () => undefined);
    expect(evaluateComparison(comparison('s', position('pos'), 'is_stale'), r)).toBe(true);
  });
});
