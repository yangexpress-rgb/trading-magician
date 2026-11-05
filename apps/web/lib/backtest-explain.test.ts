import type { BacktestOrder, PhaseConditionReport } from '@tm/backtest';
import type { Comparison } from '@tm/domain';
import { describe, expect, it } from 'vitest';
import {
  describeOrder,
  describeValues,
  explainOrder,
  summarizeConditions,
} from './backtest-explain';

const order = (patch: Partial<BacktestOrder>): BacktestOrder => ({
  cycle: 1,
  phase: 'entry',
  legId: 'l1',
  legLabel: 'Buy NKE',
  instrumentId: 'i1',
  symbol: 'NKE',
  side: 'buy',
  orderType: 'market',
  timeInForce: 'day',
  outcome: 'filled',
  reason: null,
  detail: {},
  decidedAt: '2026-10-01T20:00:00.000Z',
  activeFrom: '2026-10-02T13:30:00.000Z',
  endedAt: null,
  quantity: '10',
  limitPrice: null,
  stopPrice: null,
  referencePrice: '70',
  filledQuantity: '0',
  averagePrice: null,
  fills: 0,
  barsWorking: 0,
  bestPrice: null,
  ...patch,
});

const cmp = (operator: Comparison['operator']): Comparison => ({
  kind: 'comparison',
  id: 'c',
  operator,
  left: { kind: 'constant', id: 'l', value: '1' },
  right: { kind: 'constant', id: 'r', value: '2' },
});

describe('explainOrder', () => {
  it('explains a price-collar cancel with its figures', () => {
    expect(
      explainOrder(
        order({
          outcome: 'canceled',
          reason: 'collar_cancel',
          detail: { reference: '70', price: '74.2', movePct: '6', limitPct: '5' },
        }),
      ),
    ).toBe(
      'The next open was $74.20, 6% from the last close of $70.00. The price collar allows 5%.',
    );
  });

  it('explains an order placed at the last close of the test', () => {
    expect(
      explainOrder(order({ phase: 'exit', outcome: 'working_at_end', reason: 'no_bar_after' })),
    ).toMatch(/^It was placed at the last close, so the test ended before a bar it could fill on/);
  });

  it('leads with what filled', () => {
    expect(
      explainOrder(
        order({
          outcome: 'partial',
          reason: 'day_expired',
          filledQuantity: '4',
          averagePrice: '70.1',
          fills: 2,
        }),
      ),
    ).toBe('Filled 4 of 10 at $70.10 average. It was a day order and expired at the close.');
  });

  it('shows the best price a resting limit saw', () => {
    expect(
      explainOrder(
        order({
          orderType: 'limit',
          limitPrice: '65',
          outcome: 'working_at_end',
          reason: 'limit_not_reached',
          bestPrice: '66.5',
          barsWorking: 3,
        }),
      ),
    ).toBe('The price never reached the $65.00 limit: the best was $66.50 over 3 bars.');
  });
});

describe('explainOrder fills', () => {
  it('names one full fill and its price', () => {
    expect(explainOrder(order({ filledQuantity: '10', averagePrice: '70.25', fills: 1 }))).toBe(
      'Filled 10 at $70.25.',
    );
  });
});

describe('describeOrder', () => {
  it('writes side, size, type and time in force', () => {
    expect(describeOrder(order({ orderType: 'limit', limitPrice: '65' }))).toBe(
      'Buy 10 NKE · Limit at $65.00 · Day',
    );
  });
});

describe('describeValues', () => {
  it('shows both sides, and the previous bar for crosses', () => {
    expect(describeValues(cmp('gt'), { id: 'c', truth: true, left: '101.5', right: '100' })).toBe(
      '101.5 vs 100',
    );
    expect(
      describeValues(cmp('crosses_above'), {
        id: 'c',
        truth: true,
        left: '101',
        right: '100',
        prevLeft: '99',
        prevRight: '100',
      }),
    ).toBe('101 (was 99) vs 100 (was 100)');
    expect(describeValues(cmp('gt'), { id: 'c', truth: null, left: null, right: '100' })).toBe(
      'no data vs 100',
    );
  });
});

describe('summarizeConditions', () => {
  const report = (patch: Partial<PhaseConditionReport>) =>
    ({
      evaluated: 3,
      trueBars: 1,
      falseBars: 2,
      unknownBars: 0,
      fired: 1,
      ...patch,
    }) as PhaseConditionReport;

  it('counts the bars and firings', () => {
    expect(summarizeConditions('entry', report({}))).toBe(
      'Entry conditions were checked on 3 bars: true on 1, false on 2. They fired once.',
    );
  });

  it('says why Exit was never checked', () => {
    expect(summarizeConditions('exit', report({ evaluated: 0 }))).toBe(
      'The Exit conditions were never checked, because no Entry filled to open a position.',
    );
  });
});
