import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { createDefinition } from './defaults';
import { evaluateExpr, withPositions, type SeriesResolver } from './evaluate';
import { finestBarMinutes } from './schedule';
import { getMetric, isSessionMetric } from './metrics';
import { strategyDefinitionSchema, type MetricExpr, type StrategyDefinition } from './schema';
import { holdingSeries } from './holding-values';
import { definitionSeries } from './selection';
import { POSITION_FIELD_LABELS } from './text';
import {
  comparison,
  constant,
  context,
  market,
  order,
  position,
  STOCK_A,
  validDefinition,
} from './test-fixtures';
import { validateStrategy } from './validate';
import { planCycle, newCycleState, legKey, type LegRecord } from '../execution/cycle';

const sessionValue = (metric: string, params: Record<string, number> = {}): MetricExpr => ({
  kind: 'metric',
  id: `s-${metric}`,
  metric,
  params,
  instrumentId: STOCK_A,
});

/** The valid fixture, its Exit reading the session VWAP on bars of `interval`. */
function readingVwap(interval: '5m' | '1d'): StrategyDefinition {
  const def = validDefinition();
  def.entry.condition.children = [
    comparison('entry-vwap', market('m1', { interval }), 'gt', sessionValue('session.vwap')),
  ];
  return def;
}

describe('session values in the registry (N254)', () => {
  it('lists five session metrics, read no bars and take only a range parameter', () => {
    const ids = [
      'session.vwap',
      'session.high',
      'session.low',
      'session.opening_high',
      'session.opening_low',
    ];
    for (const id of ids) {
      const spec = getMetric(id);
      expect(spec?.category).toBe('session');
      expect(isSessionMetric(id)).toBe(true);
      expect(spec?.requirements(STOCK_A, {})).toEqual([]);
    }
    const range = getMetric('session.opening_high')?.params[0];
    expect(range).toMatchObject({ name: 'rangeMinutes', default: 30, presets: [5, 15, 30, 60] });
    expect(getMetric('session.vwap')?.params).toEqual([]);
  });

  it('adds no series to a run plan (brief §8)', () => {
    const def = readingVwap('5m');
    const withoutVwap = validDefinition();
    withoutVwap.entry.condition.children = [
      comparison('entry-vwap', market('m1', { interval: '5m' }), 'gt', constant('1')),
    ];
    expect(definitionSeries(def).map((e) => e.id)).toEqual(
      definitionSeries(withoutVwap).map((e) => e.id),
    );
  });

  it('warns, naming the metric, when the strategy has no intraday bars', () => {
    const daily = validateStrategy(readingVwap('1d'), context());
    expect(daily.warnings.find((w) => w.code === 'session_needs_intraday')?.message).toBe(
      'Session VWAP: Session values need an intraday bar size in this strategy.',
    );
    const intraday = validateStrategy(readingVwap('5m'), context());
    expect(intraday.warnings.some((w) => w.code === 'session_needs_intraday')).toBe(false);
  });

  it('counts an intraday Check Exit cadence as intraday bars, as back tests do', () => {
    const def = readingVwap('1d');
    def.exit.schedule = { which: 'every', bar: '5m', days: 'daily' };
    expect(finestBarMinutes(def)).toBe(5);
    expect(
      validateStrategy(def, context()).warnings.some((w) => w.code === 'session_needs_intraday'),
    ).toBe(false);
  });

  it('refuses bars ago on a session value', () => {
    const def = readingVwap('5m');
    def.entry.condition.children = [
      comparison('entry-vwap', market('m1', { interval: '5m' }), 'gt', {
        ...sessionValue('session.vwap'),
        offset: 2,
      }),
    ];
    expect(validateStrategy(def, context()).errors.map((e) => e.code)).toContain(
      'session_bars_ago',
    );
  });
});

describe('Minutes held (N255)', () => {
  const minutes = position('p-min', { field: 'minutes_held' });
  const resolver = (minutesHeld: number | undefined): SeriesResolver =>
    withPositions({ value: () => undefined, isStale: () => false }, () => ({
      quantity: new Decimal(10),
      averagePrice: new Decimal(100),
      ...(minutesHeld === undefined ? {} : { minutesHeld }),
    }));

  it('reads the whole minutes the engines keep, and is unknown before a fill', () => {
    expect(evaluateExpr(minutes, resolver(30))?.toString()).toBe('30');
    expect(evaluateExpr(minutes, resolver(undefined))).toBeUndefined();
  });

  it('is labelled "Minutes held" and needs no closes', () => {
    expect(POSITION_FIELD_LABELS.minutes_held).toBe('Minutes held');
    const def = validDefinition();
    def.exit.condition.children = [comparison('x', minutes, 'gte', constant('30'))];
    expect(holdingSeries(def)).toEqual([]);
    expect(strategyDefinitionSchema.safeParse(def).success).toBe(true);
  });
});

describe('Flatten at session end (N256)', () => {
  it('is an optional execution setting, off when absent', () => {
    const def = validDefinition();
    expect(def.execution.flattenAtSessionEnd).toBeUndefined();
    const on = { ...def, execution: { ...def.execution, flattenAtSessionEnd: true } };
    expect(strategyDefinitionSchema.parse(on).execution.flattenAtSessionEnd).toBe(true);
  });

  it('is an error on daily bars and fine on intraday ones', () => {
    const daily = validDefinition();
    daily.execution.flattenAtSessionEnd = true;
    expect(validateStrategy(daily, context()).errors.map((e) => e.message)).toContain(
      'Flatten at session end needs an intraday bar size',
    );
    const intraday = readingVwap('5m');
    intraday.execution.flattenAtSessionEnd = true;
    expect(
      validateStrategy(intraday, context()).errors.some((e) => e.code === 'flatten_needs_intraday'),
    ).toBe(false);
  });

  it('can be the only exit: Exit when may stay empty (brief §6a)', () => {
    const def = readingVwap('5m');
    def.exit.condition.children = [];
    const codes = () => validateStrategy(def, context()).errors.map((e) => e.code);
    expect(codes()).toContain('empty_condition');
    def.execution.flattenAtSessionEnd = true;
    expect(codes()).not.toContain('empty_condition');
  });

  const T = Date.parse('2026-10-06T19:56:00Z'); // 15:56 New York
  const filled = (legId: string, phase: LegRecord['phase'] = 'entry'): LegRecord => ({
    legId,
    phase,
    attempt: 1,
    intentId: `i-${legId}-${phase}`,
    instrumentId: STOCK_A,
    direction: phase === 'entry' ? 'buy' : 'sell',
    state: 'filled',
    quantity: new Decimal(10),
    filled: new Decimal(10),
    placedAt: T - 3_600_000,
    activeFrom: T - 3_600_000,
    firstFillAt: T - 3_600_000,
    filledAt: T - 3_600_000,
    cancelRequested: false,
  });
  function single(): StrategyDefinition {
    const def = createDefinition();
    def.entry.orders = [order('buy')];
    def.exit.orders = [order('sell', { side: 'sell' })];
    def.execution.flattenAtSessionEnd = true;
    return def;
  }

  it('flattens on paper at the session end with reason "Session end", without Exit when', () => {
    const open = { ...newCycleState(T - 3_600_000), status: 'open' as const };
    const p = planCycle({
      definition: single(),
      cycle: open,
      legs: [filled('buy')],
      positions: new Map([[STOCK_A, new Decimal(10)]]),
      now: T,
      sessionEnd: true,
    });
    expect(p.flatten).toBe(true);
    expect(p.cycle.exitReason).toBe('session_end');
    expect(p.notes).toContain('session_end');
    // The Exit leg is not also placed: the flatten closes the position.
    expect(p.submit.map((l) => l.key)).not.toContain(legKey('exit', 'sell', 1));
    const done = planCycle({
      definition: single(),
      cycle: p.cycle,
      legs: [filled('buy'), filled(`flatten-${STOCK_A}`, 'flatten')],
      positions: new Map([[STOCK_A, new Decimal(0)]]),
      now: T + 60_000,
      sessionEnd: true,
    });
    expect(done.cycle.status).toBe('closed');
    expect(done.flatten).toBe(false);
  });

  it('does nothing before the session end or when flat', () => {
    const open = { ...newCycleState(T - 3_600_000), status: 'open' as const };
    const before = planCycle({
      definition: single(),
      cycle: open,
      legs: [filled('buy')],
      positions: new Map([[STOCK_A, new Decimal(10)]]),
      now: T,
    });
    expect(before.flatten).toBe(false);
    const flat = planCycle({
      definition: single(),
      cycle: newCycleState(undefined),
      legs: [],
      positions: new Map(),
      now: T,
      sessionEnd: true,
    });
    expect(flat.flatten).toBe(false);
  });
});
