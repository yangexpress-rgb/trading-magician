import { describe, expect, it } from 'vitest';
import { createDefinition, DEFAULT_EXECUTION, DEFAULT_RISK } from './defaults';
import { sequentialIds } from './ids';
import {
  comparisonSchema,
  decimalString,
  exprSchema,
  plannedOrderSchema,
  positiveDecimalString,
  strategyDefinitionSchema,
  timingSchema,
} from './schema';
import { comparison, constant, market, order, STOCK_A, validDefinition } from './test-fixtures';

describe('decimal strings', () => {
  it.each(['0', '1', '-2.5', '123456789012345678', '0.0000000001'])('accepts %s', (v) => {
    expect(decimalString.safeParse(v).success).toBe(true);
  });

  it.each(['', '1e5', '1.', '.5', 'NaN', '1,000', '0.00000000001'])('rejects %s', (v) => {
    expect(decimalString.safeParse(v).success).toBe(false);
  });

  it('requires positive values where asked', () => {
    expect(positiveDecimalString.safeParse('0.01').success).toBe(true);
    expect(positiveDecimalString.safeParse('0').success).toBe(false);
    expect(positiveDecimalString.safeParse('0.000').success).toBe(false);
    expect(positiveDecimalString.safeParse('-1').success).toBe(false);
  });
});

describe('expressions', () => {
  it('fills series defaults', () => {
    const parsed = exprSchema.parse({
      kind: 'market',
      id: 'm',
      instrumentId: STOCK_A,
      field: 'close',
      interval: '1d',
    });
    expect(parsed).toMatchObject({
      adjustment: 'split_and_dividend',
      session: 'regular',
      offset: 0,
    });
  });

  it('requires each market expression to name an instrument', () => {
    const result = exprSchema.safeParse({
      kind: 'market',
      id: 'm',
      field: 'close',
      interval: '1d',
    });
    expect(result.success).toBe(false);
  });

  it('checks calculation arity', () => {
    const c = (op: string, n: number) =>
      exprSchema.safeParse({
        kind: 'calc',
        id: 'x',
        op,
        args: Array.from({ length: n }, (_, i) => constant(String(i + 1))),
      }).success;
    expect(c('add', 2)).toBe(true);
    expect(c('add', 3)).toBe(false);
    expect(c('neg', 1)).toBe(true);
    expect(c('abs', 2)).toBe(false);
    expect(c('max', 3)).toBe(true);
    expect(c('min', 1)).toBe(false);
  });

  it('parses nested calculations', () => {
    const nested = {
      kind: 'calc',
      id: 'outer',
      op: 'mul',
      args: [
        { kind: 'calc', id: 'inner', op: 'add', args: [constant('1'), market('m')] },
        constant('2'),
      ],
    };
    expect(exprSchema.parse(nested)).toEqual(nested);
  });
});

describe('comparisons', () => {
  it('requires a right side for binary operators', () => {
    const result = comparisonSchema.safeParse(comparison('c', market('m'), 'gt'));
    expect(result.success).toBe(false);
  });

  it('allows unary operators without a right side', () => {
    expect(comparisonSchema.safeParse(comparison('c', market('m'), 'is_available')).success).toBe(
      true,
    );
  });

  it('requires an upper bound for range operators', () => {
    expect(
      comparisonSchema.safeParse(comparison('c', market('m'), 'between', constant('1'))).success,
    ).toBe(false);
    expect(
      comparisonSchema.safeParse(
        comparison('c', market('m'), 'between', constant('1'), constant('2')),
      ).success,
    ).toBe(true);
  });
});

describe('timing', () => {
  it('requires a time zone on exact times', () => {
    expect(
      timingSchema.safeParse({ mode: 'exact', at: '2026-10-05T09:30', zone: 'UTC' }).success,
    ).toBe(false);
    expect(
      timingSchema.safeParse({
        mode: 'exact',
        at: '2026-10-05T09:30:00-04:00',
        zone: 'America/New_York',
      }).success,
    ).toBe(true);
  });

  it('rejects impossible dates', () => {
    expect(
      timingSchema.safeParse({ mode: 'exact', at: '2026-13-40T09:30Z', zone: 'UTC' }).success,
    ).toBe(false);
  });

  it('requires a positive relative delay', () => {
    const relative = (amount: number) =>
      timingSchema.safeParse({
        mode: 'relative',
        amount,
        unit: 'min',
        reference: { kind: 'phase', event: 'entry_trigger' },
      }).success;
    expect(relative(5)).toBe(true);
    expect(relative(0)).toBe(false);
    expect(relative(-1)).toBe(false);
  });
});

describe('planned orders', () => {
  it('fills defaults, including immediate timing', () => {
    const { timing, timeInForce, ...rest } = order('o');
    void timing;
    void timeInForce;
    expect(plannedOrderSchema.parse(rest)).toMatchObject({
      timing: { mode: 'immediate' },
      timeInForce: 'day',
    });
  });

  it('rejects a zero quantity and a blank leg name', () => {
    expect(
      plannedOrderSchema.safeParse(
        order('o', { quantity: { type: 'units', value: '0', rounding: 'down' } }),
      ).success,
    ).toBe(false);
    expect(plannedOrderSchema.safeParse(order('o', { legLabel: '   ' })).success).toBe(false);
  });
});

describe('strategy definition', () => {
  it('creates an empty definition with the confirmed defaults', () => {
    const def = createDefinition(sequentialIds());
    expect(def.execution).toEqual(DEFAULT_EXECUTION);
    expect(def.risk).toEqual({
      maxOrderNotional: '10000',
      maxStrategyExposure: '25000',
      maxActiveOrders: 10,
      dailyLossLimit: '1000',
      priceCollarPct: '5',
    });
    expect(def.execution).toMatchObject({
      multiLegPolicy: 'concurrent',
      legTimeoutSec: 60,
      onLegFailure: 'cancel_remaining',
      marketHoursPolicy: 'queue',
      holidayCalendar: 'NYSE',
      staleDataSec: 60,
    });
    expect(def.entry.condition.id).not.toBe(def.exit.condition.id);
  });

  it('does not share default objects between definitions', () => {
    const a = createDefinition();
    a.execution.reentry.mode = 'pyramid';
    a.risk.maxActiveOrders = 1;
    expect(DEFAULT_EXECUTION.reentry.mode).toBe('single_cycle');
    expect(DEFAULT_RISK.maxActiveOrders).toBe(10);
  });

  it('round-trips a complete definition unchanged', () => {
    const def = validDefinition();
    expect(strategyDefinitionSchema.parse(def)).toEqual(def);
  });

  it('rejects unknown schema versions', () => {
    expect(
      strategyDefinitionSchema.safeParse({ ...validDefinition(), schemaVersion: 3 }).success,
    ).toBe(false);
  });
});
