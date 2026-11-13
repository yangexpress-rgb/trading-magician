import Decimal from 'decimal.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createDefinition } from '../strategy/defaults';
import { DEFAULT_TRIGGER, type StrategyDefinition } from '../strategy/schema';
import { order, STOCK_A, STOCK_B } from '../strategy/test-fixtures';
import {
  activeFromFor,
  legKey,
  regularSessionOpenAt,
  sendsExtendedHours,
  newCycleState,
  newRuntimeTriggerState,
  planCycle,
  planEntry,
  type CycleState,
  type LegRecord,
} from './cycle';
import type { OrderState } from './order-state';

/** Tuesday 2026-10-06 10:00 New York. */
const T0 = Date.parse('2026-10-06T14:00:00Z');
const s = (n: number) => T0 + n * 1000;
const d = (v: number | string) => new Decimal(v);

/** These tests cover "As soon as it becomes true", the default before N273. */
function onTransition(): StrategyDefinition {
  const def = createDefinition();
  def.entry.trigger = { ...DEFAULT_TRIGGER };
  def.exit.trigger = { ...DEFAULT_TRIGGER };
  return def;
}

function single(): StrategyDefinition {
  const def = onTransition();
  def.entry.orders = [order('buy')];
  def.exit.orders = [order('sell', { side: 'sell' })];
  return def;
}
function pair(): StrategyDefinition {
  const def = onTransition();
  def.entry.orders = [
    order('long', { instrumentId: STOCK_A }),
    order('short', { instrumentId: STOCK_B, side: 'sell_short' }),
  ];
  def.exit.orders = [
    order('cover', { instrumentId: STOCK_B, side: 'buy_to_cover' }),
    order('sell', { instrumentId: STOCK_A, side: 'sell' }),
  ];
  return def;
}

function leg(legId: string, state: OrderState, partial: Partial<LegRecord> = {}): LegRecord {
  const filled = partial.filled ?? (state === 'filled' ? (partial.quantity ?? d(10)) : d(0));
  return {
    legId,
    phase: 'entry',
    attempt: 1,
    intentId: `intent-${legId}-${partial.phase ?? 'entry'}-${partial.attempt ?? 1}`,
    instrumentId: STOCK_A,
    direction: 'buy',
    state,
    quantity: d(10),
    filled,
    placedAt: s(0),
    activeFrom: s(0),
    firstFillAt: filled.gt(0) ? s(1) : undefined,
    filledAt: state === 'filled' ? s(1) : undefined,
    cancelRequested: false,
    ...partial,
  };
}
const held = (entries: [string, number][] = []) =>
  new Map(entries.map(([k, v]) => [k, d(v)] as [string, Decimal]));
const triggered = (at = s(0)): CycleState => newCycleState(at);

describe('planCycle: one leg each way', () => {
  it('places the Entry leg when the trigger fires', () => {
    const p = planCycle({
      definition: single(),
      cycle: triggered(),
      legs: [],
      positions: held(),
      now: s(0),
    });
    expect(p.submit.map((l) => l.key)).toEqual([legKey('entry', 'buy', 1)]);
    expect(p.submit[0]!.reference).toEqual({ kind: 'trigger', phase: 'entry' });
    expect(p.cycle.status).toBe('entry_working');
  });

  it('never places the same leg twice once it is recorded', () => {
    const p = planCycle({
      definition: single(),
      cycle: triggered(),
      legs: [leg('buy', 'acknowledged')],
      positions: held(),
      now: s(5),
    });
    expect(p.submit).toEqual([]);
    expect(p.cycle.status).toBe('entry_working');
  });

  it('opens the position on the full Entry fill and waits for Exit', () => {
    const p = planCycle({
      definition: single(),
      cycle: triggered(),
      legs: [leg('buy', 'filled')],
      positions: held([[STOCK_A, 10]]),
      now: s(5),
    });
    expect(p.cycle.status).toBe('open');
    expect(p.cycle.positionOpenedAt).toBe(s(1));
    expect(p.notes).toContain('position_opened');
    expect(p.submit).toEqual([]);
  });

  it('does not exit before the Entry milestone, even when the Exit condition is true', () => {
    const p = planCycle({
      definition: single(),
      cycle: triggered(),
      legs: [leg('buy', 'partially_filled', { filled: d(4) })],
      positions: held([[STOCK_A, 4]]),
      now: s(5),
      exitTruth: { truth: true },
    });
    expect(p.cycle.status).toBe('entry_working');
    expect(p.submit).toEqual([]);
  });

  it('places the Exit leg on the Exit trigger, then closes once flat', () => {
    const open: CycleState = { ...triggered(), status: 'open', positionOpenedAt: s(1) };
    const p = planCycle({
      definition: single(),
      cycle: open,
      legs: [leg('buy', 'filled')],
      positions: held([[STOCK_A, 10]]),
      now: s(60),
      exitTruth: { truth: true },
    });
    expect(p.cycle.status).toBe('exit_working');
    expect(p.submit.map((l) => l.key)).toEqual([legKey('exit', 'sell', 1)]);

    const closed = planCycle({
      definition: single(),
      cycle: p.cycle,
      legs: [leg('buy', 'filled'), leg('sell', 'filled', { phase: 'exit', direction: 'sell' })],
      positions: held([[STOCK_A, 0]]),
      now: s(70),
    });
    expect(closed.cycle.status).toBe('closed');
    expect(closed.notes).toContain('closed');
  });

  it('aborts a cycle whose only Entry leg was rejected', () => {
    const p = planCycle({
      definition: single(),
      cycle: triggered(),
      legs: [leg('buy', 'rejected')],
      positions: held(),
      now: s(1),
    });
    expect(p.cycle.status).toBe('aborted');
  });

  it('re-arms Exit when the Exit leg ends with something still held', () => {
    const exiting: CycleState = {
      ...triggered(),
      status: 'exit_working',
      exitTriggeredAt: s(60),
      positionOpenedAt: s(1),
    };
    const p = planCycle({
      definition: single(),
      cycle: exiting,
      legs: [
        leg('buy', 'filled'),
        leg('sell', 'canceled', { phase: 'exit', direction: 'sell', filled: d(6) }),
      ],
      positions: held([[STOCK_A, 4]]),
      now: s(120),
    });
    expect(p.cycle).toMatchObject({ status: 'open', exitRound: 2 });
    expect(p.notes).toContain('exit_incomplete');
    // The next Exit trigger places round 2 of the leg.
    const again = planCycle({
      definition: single(),
      cycle: p.cycle,
      legs: [
        leg('buy', 'filled'),
        leg('sell', 'canceled', { phase: 'exit', direction: 'sell', filled: d(6) }),
      ],
      positions: held([[STOCK_A, 4]]),
      now: s(180),
      exitTruth: { truth: true },
    });
    expect(again.submit.map((l) => l.key)).toEqual([legKey('exit', 'sell', 2)]);
  });
});

describe('planCycle: timing (§6.8)', () => {
  it('schedules an Exit five minutes after the Entry order was placed, without the Exit condition', () => {
    const def = single();
    def.execution.timingOnly = true;
    def.exit.orders = [
      order('sell', {
        side: 'sell',
        timing: {
          mode: 'relative',
          amount: 5,
          unit: 'min',
          reference: { kind: 'phase', event: 'entry_submitted' },
        },
      }),
    ];
    const legs = [leg('buy', 'filled', { placedAt: s(0) })];
    const open: CycleState = { ...triggered(), status: 'open', positionOpenedAt: s(1) };
    const early = planCycle({
      definition: def,
      cycle: open,
      legs,
      positions: held([[STOCK_A, 10]]),
      now: s(60),
    });
    expect(early.submit).toEqual([]);
    expect(early.scheduled).toEqual([
      expect.objectContaining({
        key: legKey('exit', 'sell', 1),
        dueAt: s(300),
        reference: { kind: 'event', event: 'entry_submitted' },
      }),
    ]);
    const due = planCycle({
      definition: def,
      cycle: open,
      legs,
      positions: held([[STOCK_A, 10]]),
      now: s(300),
    });
    expect(due.submit.map((l) => l.key)).toEqual([legKey('exit', 'sell', 1)]);
    expect(due.cycle.status).toBe('exit_working');
  });

  it('waits for both the trigger and an exact time unless the leg is timing only', () => {
    const def = single();
    const at = new Date(s(600)).toISOString();
    def.entry.orders = [order('buy', { timing: { mode: 'exact', at, zone: 'UTC' } })];
    const before = planCycle({
      definition: def,
      cycle: triggered(),
      legs: [],
      positions: held(),
      now: s(10),
    });
    expect(before.scheduled[0]).toMatchObject({ dueAt: s(600), reference: { kind: 'time' } });
    const untriggered = planCycle({
      definition: def,
      cycle: newCycleState(undefined),
      legs: [],
      positions: held(),
      now: s(700),
    });
    expect(untriggered.submit).toEqual([]);
  });

  it('places a leg relative to another leg filling', () => {
    const def = pair();
    def.entry.orders[1]!.timing = {
      mode: 'relative',
      amount: 30,
      unit: 's',
      reference: { kind: 'leg', legId: 'long', event: 'filled' },
    };
    const p = planCycle({
      definition: def,
      cycle: triggered(),
      legs: [leg('long', 'filled', { filledAt: s(10) })],
      positions: held([[STOCK_A, 10]]),
      now: s(20),
    });
    expect(p.scheduled).toEqual([
      expect.objectContaining({
        legId: 'short',
        dueAt: s(40),
        reference: { kind: 'leg', legKey: legKey('entry', 'long', 1), event: 'filled' },
      }),
    ]);
  });
});

describe('planCycle: multi-leg policy (§6.7)', () => {
  it('places concurrent legs together', () => {
    const p = planCycle({
      definition: pair(),
      cycle: triggered(),
      legs: [],
      positions: held(),
      now: s(0),
    });
    expect(p.submit.map((l) => l.legId)).toEqual(['long', 'short']);
  });

  it('waits for the prior leg to fill under after-prior-fill', () => {
    const def = pair();
    def.execution.multiLegPolicy = 'after_prior_fill';
    def.execution.legOrder = ['short', 'long'];
    const first = planCycle({
      definition: def,
      cycle: triggered(),
      legs: [],
      positions: held(),
      now: s(0),
    });
    expect(first.submit.map((l) => l.legId)).toEqual(['short']);
    const second = planCycle({
      definition: def,
      cycle: triggered(),
      legs: [leg('short', 'filled', { instrumentId: STOCK_B, direction: 'sell' })],
      positions: held([[STOCK_B, -10]]),
      now: s(5),
    });
    expect(second.submit.map((l) => l.legId)).toEqual(['long']);
  });

  it('cancels a leg after the timeout and keeps what filled (decision of 2026-10-04)', () => {
    const legs = [
      leg('long', 'filled'),
      leg('short', 'acknowledged', { instrumentId: STOCK_B, direction: 'sell' }),
    ];
    const p = planCycle({
      definition: pair(),
      cycle: triggered(),
      legs,
      positions: held([[STOCK_A, 10]]),
      now: s(61),
    });
    expect(p.cancel).toEqual([{ intentId: legs[1]!.intentId, reason: 'leg_timeout' }]);
    expect(p.cycle.status).toBe('entry_working');

    // Once the cancel lands, the cycle opens with what it holds and flags the imbalance.
    const after = planCycle({
      definition: pair(),
      cycle: triggered(),
      legs: [legs[0]!, { ...legs[1]!, state: 'canceled', cancelRequested: true }],
      positions: held([[STOCK_A, 10]]),
      now: s(62),
    });
    expect(after.cycle.status).toBe('open');
    expect(after.notes).toEqual(expect.arrayContaining(['leg_failed', 'entry_incomplete']));
  });

  it('measures the timeout from the next open when the order waited for the market', () => {
    const friday = Date.parse('2026-10-09T21:00:00Z');
    const monday = activeFromFor(friday, 'queue');
    expect(new Date(monday!).toISOString()).toBe('2026-10-12T13:30:00.000Z');
    expect(activeFromFor(friday, 'cancel')).toBeUndefined();
    expect(activeFromFor(T0, 'queue')).toBe(T0);
  });

  it('cancels the other legs when one is rejected, and skips legs not yet placed', () => {
    const def = pair();
    def.execution.multiLegPolicy = 'sequential';
    const legs = [leg('long', 'rejected')];
    const p = planCycle({
      definition: def,
      cycle: triggered(),
      legs,
      positions: held(),
      now: s(1),
    });
    expect(p.submit).toEqual([]);
    expect(p.cycle.skipped).toEqual([legKey('entry', 'short', 1)]);
    expect(p.cycle.status).toBe('aborted');
  });

  it('flattens what filled when the policy says so, then closes', () => {
    const def = pair();
    def.execution.onLegFailure = 'flatten_filled';
    const legs = [
      leg('long', 'filled'),
      leg('short', 'rejected', { instrumentId: STOCK_B, direction: 'sell' }),
    ];
    const p = planCycle({
      definition: def,
      cycle: triggered(),
      legs,
      positions: held([[STOCK_A, 10]]),
      now: s(2),
    });
    expect(p.flatten).toBe(true);
    expect(p.cycle.flattened).toBe(true);
    const again = planCycle({
      definition: def,
      cycle: p.cycle,
      legs,
      positions: held([[STOCK_A, 10]]),
      now: s(3),
    });
    expect(again.flatten).toBe(false);
    const done = planCycle({
      definition: def,
      cycle: p.cycle,
      legs: [...legs, leg(`flatten-${STOCK_A}`, 'filled', { phase: 'flatten', direction: 'sell' })],
      positions: held([[STOCK_A, 0]]),
      now: s(4),
    });
    expect(done.cycle.status).toBe('closed');
  });

  it('is a pure function of its input', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<OrderState>('acknowledged', 'filled', 'canceled', 'rejected'),
        fc.constantFrom<OrderState>('acknowledged', 'filled', 'canceled', 'partially_filled'),
        fc.integer({ min: 0, max: 200 }),
        (a, b, n) => {
          const input = {
            definition: pair(),
            cycle: triggered(),
            legs: [
              leg('long', a),
              leg('short', b, {
                instrumentId: STOCK_B,
                direction: 'sell' as const,
                ...(b === 'partially_filled' ? { filled: d(3) } : {}),
              }),
            ],
            positions: held([[STOCK_A, a === 'filled' ? 10 : 0]]),
            now: s(n),
          };
          const snapshot = structuredClone(input.cycle);
          expect(planCycle(input)).toEqual(planCycle(input));
          expect(input.cycle).toEqual(snapshot);
        },
      ),
    );
  });
});

describe('planEntry', () => {
  const def = single();
  it('starts a cycle on a false-to-true transition only', () => {
    let state = newRuntimeTriggerState();
    const step = (truth: boolean | undefined, now: number, active: number) => {
      const r = planEntry({
        definition: def,
        state,
        active: Array.from({ length: active }, (_, i) => ({ id: `c${i}`, cycle: triggered() })),
        now,
        entryTruth: { truth },
        halted: false,
      });
      state = r.state;
      return r.decision.kind;
    };
    expect(step(true, s(0), 0)).toBe('none'); // no prior false: not a transition
    expect(step(false, s(1), 0)).toBe('none');
    expect(step(true, s(2), 0)).toBe('new_cycle');
    expect(step(false, s(3), 1)).toBe('none');
    expect(step(true, s(4), 1)).toBe('none'); // one open cycle at a time
  });

  it('does nothing without new data, and nothing while halted', () => {
    const state = {
      ...newRuntimeTriggerState(),
      entryTrigger: { prev: false, consecutive: 0, fired: 0 },
    };
    expect(
      planEntry({ definition: def, state, active: [], now: s(0), halted: false }).decision,
    ).toEqual({ kind: 'none' });
    expect(
      planEntry({
        definition: def,
        state,
        active: [],
        now: s(0),
        entryTruth: { truth: true },
        halted: true,
      }).decision,
    ).toEqual({ kind: 'none' });
  });

  it('opens one cycle for a timing-only exact Entry leg', () => {
    const exact = single();
    exact.execution.timingOnly = true;
    exact.entry.orders = [
      order('buy', {
        timing: { mode: 'exact', at: new Date(s(30)).toISOString(), zone: 'UTC' },
      }),
    ];
    const first = planEntry({
      definition: exact,
      state: newRuntimeTriggerState(),
      active: [],
      now: s(30),
      halted: false,
    });
    expect(first.decision).toEqual({ kind: 'new_cycle', triggered: false });
    const second = planEntry({
      definition: exact,
      state: first.state,
      active: [],
      now: s(90),
      halted: false,
    });
    expect(second.decision).toEqual({ kind: 'none' });
  });
});

describe('extended hours under the market-hours policy (§6.8)', () => {
  const dayLimit = { orderType: 'limit', timeInForce: 'day' } as const;
  /** Tuesday 2026-10-06 8:00 New York, before the open. */
  const PRE = Date.parse('2026-10-06T12:00:00Z');

  it('knows when the regular session is open', () => {
    expect(regularSessionOpenAt(T0)).toBe(true);
    expect(regularSessionOpenAt(PRE)).toBe(false);
  });

  it('sends a day limit leg early only under "extended hours if supported"', () => {
    expect(sendsExtendedHours(dayLimit, 'extended_if_supported', false, true)).toBe(true);
    expect(sendsExtendedHours(dayLimit, 'queue', false, true)).toBe(false);
    expect(sendsExtendedHours(dayLimit, 'extended_if_supported', true, true)).toBe(false);
  });

  it('keeps market orders, other time in force and accounts without extended hours waiting', () => {
    expect(
      sendsExtendedHours(
        { ...dayLimit, orderType: 'market' },
        'extended_if_supported',
        false,
        true,
      ),
    ).toBe(false);
    expect(
      sendsExtendedHours({ ...dayLimit, timeInForce: 'gtc' }, 'extended_if_supported', false, true),
    ).toBe(false);
    expect(sendsExtendedHours(dayLimit, 'extended_if_supported', false, false)).toBe(false);
  });
});
