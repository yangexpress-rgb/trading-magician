import { describe, expect, it } from 'vitest';
import { BUILDER_INDICATORS, INDICATORS } from './catalog';
import { getMetric } from './metrics';
import { migrateV1 } from './migrate-v1';
import { parseDefinition } from './serialize';
import {
  comparison,
  constant,
  context,
  indicator,
  market,
  STOCK_A,
  STOCK_B,
  validDefinition,
} from './test-fixtures';
import { validateStrategy } from './validate';

type Json = Record<string, unknown>;

/** A schema 1 document, as saved before the Strategy Lab simplification (ADR 0049). */
function v1(
  edit: (d: Json & { entry: Json; exit: Json; execution: Json; risk: Json }) => void = () => {},
) {
  const def = JSON.parse(JSON.stringify(validDefinition())) as Json & {
    entry: Json & { orders: Json[]; trigger: Json };
    exit: Json & { orders: Json[]; trigger: Json };
    execution: Json;
    risk: Json;
  };
  def.schemaVersion = 1;
  delete def.exit.mirrorEntry;
  for (const o of [...def.entry.orders, ...def.exit.orders]) {
    o.extendedHours = false;
    o.timingOnly = false;
  }
  for (const t of [def.entry.trigger, def.exit.trigger]) {
    delete t.cooldownBars;
    t.cooldownSec = 0;
  }
  def.risk.maxOpenPositions = def.risk.maxInstrumentsHeld;
  delete def.risk.maxInstrumentsHeld;
  edit(def);
  return def;
}

const codes = (doc: Json) => migrateV1(doc).notes.map((n) => n.code);
const valid = (doc: Json) => validateStrategy(parseDefinition(doc), context()).errors;

describe('migrateV1 (schema 1 → 2)', () => {
  it('migrates a plain strategy to one that validates, with nothing that changes behaviour', () => {
    const { doc, notes } = migrateV1(v1());
    expect(doc.schemaVersion).toBe(2);
    expect(notes.filter((n) => n.effect !== 'same')).toEqual([]);
    expect(codes(v1())).toEqual(['mirror_off', 'max_instruments_held']);
    expect(valid(v1())).toEqual([]);
    const parsed = parseDefinition(v1());
    expect(parsed.risk.maxInstrumentsHeld).toBe(validDefinition().risk.maxInstrumentsHeld);
    expect(parsed.entry.orders[0]).not.toHaveProperty('extendedHours');
    expect(parsed.entry.trigger.cooldownBars).toBe(0);
  });

  it('turns the per-leg timing-only boxes into the strategy switch, and says which legs widen', () => {
    const doc = v1((d) => {
      const [buy] = d.entry.orders as Json[];
      buy!.timingOnly = true;
      buy!.timing = {
        mode: 'relative',
        amount: 5,
        unit: 'min',
        reference: { kind: 'phase', event: 'entry_trigger' },
      };
      (d.exit.orders as Json[])[0]!.timing = {
        mode: 'relative',
        amount: 1,
        unit: 'd',
        reference: { kind: 'phase', event: 'position_opened' },
      };
    });
    const { doc: out, notes } = migrateV1(doc);
    expect((out.execution as Json).timingOnly).toBe(true);
    expect(notes.find((n) => n.code === 'timing_only_widened')).toMatchObject({
      effect: 'changes',
      where: 'exit.orders[0]',
    });
  });

  it('moves the extended-hours box to the market-hours policy', () => {
    const limit = v1((d) => {
      Object.assign((d.entry.orders as Json[])[0]!, {
        extendedHours: true,
        orderType: 'limit',
        limitPrice: constant('100'),
      });
    });
    const { doc, notes } = migrateV1(limit);
    expect((doc.execution as Json).marketHoursPolicy).toBe('extended_if_supported');
    expect(notes.find((n) => n.code === 'extended_hours_policy')?.effect).toBe('same');
    const marketLeg = v1((d) => ((d.entry.orders as Json[])[0]!.extendedHours = true));
    expect(migrateV1(marketLeg).notes.find((n) => n.code === 'extended_hours_policy')?.effect).toBe(
      'changes',
    );
  });

  it('turns the Exit mirror on only when Exit was still what Entry pre-fills', () => {
    const mirrored = v1((d) => {
      d.exit.orders = [
        {
          id: 'x1',
          legLabel: 'Exit buy-a',
          instrumentId: STOCK_A,
          accountId: (d.entry.orders as Json[])[0]!.accountId,
          side: 'sell',
          quantity: { type: 'units', value: '10', rounding: 'down' },
          orderType: 'market',
          timeInForce: 'day',
          extendedHours: false,
          timing: { mode: 'immediate' },
          timingOnly: false,
        },
      ];
    });
    expect(parseDefinition(mirrored).exit.mirrorEntry).toBe(true);
    expect(parseDefinition(v1()).exit.mirrorEntry).toBe(false);
  });

  it('merges the risk quantity types and enters the ATR distance once', () => {
    const doc = v1((d) => {
      (d.entry.orders as Json[])[0]!.quantity = {
        type: 'risk_atr',
        value: '1',
        rounding: 'down',
        atrPeriod: 20,
        atrMultiple: '2',
      };
      d.exit.rules = [{ kind: 'atrStop', id: 'stop', atrPeriod: 20, atrMultiple: '2.0' }];
    });
    const def = parseDefinition(doc);
    expect(def.entry.orders[0]!.quantity).toEqual({
      type: 'risk',
      value: '1',
      rounding: 'down',
      amountIn: 'pct_equity',
      distanceFrom: 'atr',
    });
    expect(def.entry.risk).toEqual({ atrPeriod: 20, atrMultiple: '2' });
    expect(def.exit.rules).toEqual([{ kind: 'atrStop', id: 'stop' }]);
    expect(codes(doc)).toContain('atr_stop_shares_distance');
    expect(valid(doc)).toEqual([]);

    const differs = v1((d) => {
      (d.entry.orders as Json[])[0]!.quantity = {
        type: 'risk_atr',
        value: '1',
        atrPeriod: 20,
        atrMultiple: '2',
      };
      d.exit.rules = [{ kind: 'atrStop', id: 'stop', atrPeriod: 10, atrMultiple: '3' }];
    });
    expect(parseDefinition(differs).exit.rules).toEqual([
      { kind: 'atrStop', id: 'stop', override: { atrPeriod: 10, atrMultiple: '3' } },
    ]);

    const dollars = v1((d) => {
      Object.assign((d.entry.orders as Json[])[0]!, {
        quantity: { type: 'risk_sized', value: '200', rounding: 'down' },
        stopPrice: constant('95'),
        orderType: 'stop',
      });
    });
    expect(parseDefinition(dollars).entry.orders[0]!.quantity).toMatchObject({
      type: 'risk',
      amountIn: 'dollars',
      distanceFrom: 'stop_price',
    });
  });

  it('turns best-by-metric into a Selection group of these legs', () => {
    const doc = v1((d) => {
      d.entry.orders = [
        { ...(d.entry.orders as Json[])[0]!, legCondition: group('lc1') },
        {
          ...(d.entry.orders as Json[])[0]!,
          id: 'buy-b',
          legLabel: 'buy-b',
          instrumentId: STOCK_B,
          legCondition: group('lc2'),
        },
      ];
      d.entry.fireMode = {
        mode: 'bestByMetric',
        metric: { metric: 'return', params: { lookback: 20 } },
      };
      d.exit.trigger = { mode: 'on_transition', cooldownSec: 0, confirmationBars: 0 };
    });
    const def = parseDefinition(doc);
    expect(def.entry.kind).toBe('selection');
    expect(def.entry.selection).toEqual({
      universe: { type: 'legs' },
      ranking: { metric: 'return', params: { lookback: 20 } },
      direction: 'desc',
      count: { type: 'fixed', value: 1 },
    });
    expect(def.exit.trigger).toBeUndefined();
    expect(codes(doc)).toEqual(expect.arrayContaining(['best_by_metric', 'slot_exit_trigger']));
  });

  it('reads cooldowns in bars, saying when the seconds did not divide into days', () => {
    const doc = v1((d) => ((d.entry.trigger as Json).cooldownSec = 86_400 * 2 + 3600));
    expect(parseDefinition(doc).entry.trigger.cooldownBars).toBe(2);
    expect(migrateV1(doc).notes.find((n) => n.code === 'cooldown_bars')?.effect).toBe('changes');
  });

  it('lists every Exit-leg stop order as grandfathered and keeps it working', () => {
    const doc = v1((d) => {
      Object.assign((d.exit.orders as Json[])[0]!, {
        orderType: 'stop',
        stopPrice: constant('90'),
      });
    });
    expect(migrateV1(doc).notes.find((n) => n.code === 'exit_leg_stop')).toMatchObject({
      effect: 'grandfathered',
      where: 'exit.orders[0]',
    });
    expect(parseDefinition(doc).exit.orders[0]!.orderType).toBe('stop');
    expect(valid(doc)).toEqual([]);
  });

  it('rewrites the RSI indicator as the RSI metric and Bollinger as the statistic', () => {
    const doc = v1((d) => {
      (d.entry.condition as Json).children = [
        comparison('rsi', indicatorV1('r', 'RSI', { period: 2 }, 1), 'lt', constant('10')),
        comparison(
          'bb',
          market('m'),
          'lt',
          indicatorV1('b', 'BBANDS', { period: 20, stdDev: 2, band: 'lower' }),
        ),
      ];
    });
    const def = parseDefinition(doc);
    const [rsi, bb] = def.entry.condition.children as ReturnType<typeof comparison>[];
    expect(rsi!.left).toEqual({
      kind: 'metric',
      id: 'r',
      metric: 'rsi',
      params: { period: 2 },
      instrumentId: STOCK_A,
      offset: 1,
    });
    expect(bb!.right).toMatchObject({
      kind: 'stat',
      id: 'b',
      fn: 'BB_LOWER',
      period: 20,
      multiplier: '2',
    });
    expect(codes(doc)).toEqual(expect.arrayContaining(['rsi_metric', 'bollinger_statistic']));
    expect(valid(doc)).toEqual([]);
  });

  it('derives direction from the legs', () => {
    expect(codes(v1((d) => (d.entry.direction = 'long')))).toContain('direction_derived');
    expect(
      migrateV1(v1((d) => (d.entry.direction = 'short'))).notes.find(
        (n) => n.code === 'direction_mismatch',
      )?.effect,
    ).toBe('changes');
  });

  it('never touches its input', () => {
    const doc = v1((d) => ((d.entry.orders as Json[])[0]!.extendedHours = true));
    const copy = JSON.stringify(doc);
    migrateV1(doc);
    expect(JSON.stringify(doc)).toBe(copy);
  });
});

function group(id: string) {
  return {
    kind: 'group',
    id,
    op: 'and',
    negate: false,
    children: [comparison(`${id}-c`, market(`${id}-m`), 'gt', constant('1'))],
  };
}

function indicatorV1(
  id: string,
  name: 'RSI' | 'BBANDS',
  params: Record<string, string | number>,
  offset = 0,
) {
  return indicator(id, { name, params, offset });
}

describe('one computation per name (ADR 0049)', () => {
  it('offers RSI and Bollinger bands once each: as a metric and a statistic, not as indicators', () => {
    expect(BUILDER_INDICATORS.map((i) => i.name)).not.toContain('RSI');
    expect(BUILDER_INDICATORS.map((i) => i.name)).not.toContain('BBANDS');
    expect(getMetric('rsi')).toBeDefined();
    // Still in the catalog, so a strategy kept as saved still runs.
    expect(INDICATORS.map((i) => i.name)).toEqual(expect.arrayContaining(['RSI', 'BBANDS']));
  });
});
