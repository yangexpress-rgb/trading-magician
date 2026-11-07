import { createDefinition, type ConditionGroup, type Expr, type PlannedOrder } from '@tm/domain';
import { describe, expect, it } from 'vitest';
import {
  describeCondition,
  describeExpr,
  describeIssueLocation,
  describeLeg,
  describeTiming,
} from './strategy-text';

const symbols: Record<string, string> = { a: 'DEMO-A', b: 'DEMO-B' };
const symbol = (id: string) => symbols[id];
const series = {
  field: 'close' as const,
  interval: '1d' as const,
  adjustment: 'split_and_dividend' as const,
  session: 'regular' as const,
  offset: 0,
};
const sma = (id: string, instrumentId: string): Expr => ({
  kind: 'indicator',
  id,
  name: 'SMA',
  params: { period: 30 },
  instrumentId,
  ...series,
});

describe('strategy text', () => {
  it('names each side with its own instrument', () => {
    expect(describeExpr(sma('x', 'a'), symbol)).toBe('SMA(30) of DEMO-A close');
    expect(
      describeExpr({ kind: 'market', id: 'm', instrumentId: 'b', ...series, offset: 2 }, symbol),
    ).toBe('DEMO-B close 2 bars ago');
  });

  it('writes the window offset of Highest and Lowest as a parameter (v1.2 item 7)', () => {
    const hi: Expr = {
      kind: 'indicator',
      id: 'h',
      name: 'HIGHEST',
      params: { period: 20 },
      instrumentId: 'a',
      ...series,
      field: 'high',
      offset: 1,
    };
    expect(describeExpr(hi, symbol)).toBe('HIGHEST(20, offset 1) of DEMO-A high');
    expect(describeExpr({ ...hi, offset: 0 }, symbol)).toBe('HIGHEST(20, offset 0) of DEMO-A high');
  });

  it('describes calculations', () => {
    expect(
      describeExpr(
        {
          kind: 'calc',
          id: 'c',
          op: 'div',
          args: [sma('l', 'a'), { kind: 'constant', id: 'k', value: '2' }],
        },
        symbol,
      ),
    ).toBe('(SMA(30) of DEMO-A close ÷ 2)');
  });

  it('makes grouping explicit', () => {
    const tree: ConditionGroup = {
      kind: 'group',
      id: 'root',
      op: 'and',
      negate: false,
      children: [
        { kind: 'comparison', id: 'c1', left: sma('l', 'a'), operator: 'lt', right: sma('r', 'b') },
        {
          kind: 'group',
          id: 'g',
          op: 'or',
          negate: true,
          children: [
            {
              kind: 'comparison',
              id: 'c2',
              left: { kind: 'market', id: 'm', instrumentId: 'a', ...series },
              operator: 'is_stale',
            },
          ],
        },
      ],
    };
    expect(describeCondition(tree, symbol)).toBe(
      'SMA(30) of DEMO-A close < SMA(30) of DEMO-B close AND NOT (DEMO-A close is stale)',
    );
  });

  const leg = (patch: Partial<PlannedOrder> = {}): PlannedOrder => ({
    id: 'l1',
    legLabel: 'Long A',
    instrumentId: 'a',
    accountId: '00000000-0000-4000-8000-000000000001',
    side: 'buy',
    quantity: { type: 'units', value: '100', rounding: 'down' },
    orderType: 'market',
    timeInForce: 'day',
    extendedHours: false,
    timing: { mode: 'immediate' },
    timingOnly: false,
    ...patch,
  });

  it('describes a leg with its own instrument, price and time in force', () => {
    expect(describeLeg(leg(), symbol, 'USD')).toBe('Buy 100 DEMO-A · Market · Day');
    expect(
      describeLeg(
        leg({
          side: 'sell_short',
          instrumentId: 'b',
          quantity: { type: 'notional', value: '500', rounding: 'down' },
          orderType: 'limit',
          limitPrice: { kind: 'constant', id: 'p', value: '99.5' },
          timeInForce: 'gtc',
          extendedHours: true,
        }),
        symbol,
        'USD',
      ),
    ).toBe('Sell short USD 500 of DEMO-B · Limit at 99.5 · Good till cancelled · extended hours');
  });

  it('describes relative timing against a phase event or another leg', () => {
    expect(describeTiming(leg(), () => undefined)).toBe('Immediately when the conditions qualify');
    expect(
      describeTiming(
        leg({
          timing: {
            mode: 'relative',
            amount: 5,
            unit: 'min',
            reference: { kind: 'leg', legId: 'l0', event: 'filled' },
          },
          timingOnly: true,
        }),
        (id) => (id === 'l0' ? 'Short B' : undefined),
      ),
    ).toBe('5 minutes after “Short B” filled (timing only)');
  });

  it('names where a validation issue lives', () => {
    const def = createDefinition();
    def.exit.orders = [leg(), leg({ id: 'l2', legLabel: 'Cover B' })];
    expect(describeIssueLocation(['exit', 'orders', 1, 'side'], def)).toBe('Exit leg 2 (Cover B)');
    expect(describeIssueLocation(['entry', 'condition', 'children'], def)).toBe('Entry conditions');
    expect(describeIssueLocation(['risk', 'dailyLossLimit'], def)).toBe('Risk limits');
    expect(describeIssueLocation(['execution', 'legOrder'], def)).toBe('Execution');
    expect(describeIssueLocation([], def)).toBe('Strategy');
  });
});
