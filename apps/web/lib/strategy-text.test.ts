import type { ConditionGroup, Expr } from '@tm/domain';
import { describe, expect, it } from 'vitest';
import { describeCondition, describeExpr } from './strategy-text';

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
});
