import Decimal from 'decimal.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  canTransitionOrder,
  deriveBrokerOrder,
  isTerminalOrderState,
  ORDER_STATES,
  OrderTransitionError,
  TERMINAL_ORDER_STATES,
  transitionOrder,
  type BrokerUpdate,
} from './order-state';

const at = (s: number) => new Date(Date.UTC(2026, 9, 5, 14, 30, s)).toISOString();
const fill = (id: string, s: number, quantity: string, price: string): BrokerUpdate => ({
  eventId: id,
  kind: 'fill',
  rawStatus: 'partially_filled',
  at: at(s),
  fill: { quantity, price, fee: '0' },
});
const ack: BrokerUpdate = { eventId: 'ack', kind: 'accepted', rawStatus: 'new', at: at(0) };

describe('app transitions', () => {
  it('walks the §8.4 path from planned to submitted', () => {
    let s = transitionOrder('planned', 'scheduled');
    s = transitionOrder(s, 'pending_risk');
    s = transitionOrder(s, 'ready');
    expect(transitionOrder(s, 'submitted')).toBe('submitted');
  });

  it('never leaves a terminal state', () => {
    for (const from of TERMINAL_ORDER_STATES)
      for (const to of ORDER_STATES) expect(canTransitionOrder(from, to)).toBe(false);
  });

  it('rejects skipping the risk check', () => {
    expect(() => transitionOrder('scheduled', 'ready')).toThrow(OrderTransitionError);
    expect(() => transitionOrder('planned', 'submitted')).toThrow(OrderTransitionError);
  });
});

describe('deriveBrokerOrder', () => {
  it('is submitted until the broker answers', () => {
    expect(deriveBrokerOrder(new Decimal(10), []).state).toBe('submitted');
    expect(deriveBrokerOrder(new Decimal(10), [ack]).state).toBe('acknowledged');
  });

  it('tracks partial and full fills with a weighted average price', () => {
    const partial = deriveBrokerOrder(new Decimal(10), [ack, fill('f1', 1, '4', '100')]);
    expect(partial.state).toBe('partially_filled');
    expect(partial.filledQuantity.toString()).toBe('4');
    const full = deriveBrokerOrder(new Decimal(10), [
      ack,
      fill('f1', 1, '4', '100'),
      fill('f2', 2, '6', '101'),
    ]);
    expect(full.state).toBe('filled');
    expect(full.averagePrice?.toString()).toBe('100.6');
    expect(full.filledAt).toBe(at(2));
    expect(full.terminalAt).toBe(at(2));
  });

  it('keeps a partial fill on a canceled order', () => {
    const v = deriveBrokerOrder(new Decimal(10), [
      ack,
      fill('f1', 1, '4', '100'),
      { eventId: 'c', kind: 'canceled', rawStatus: 'canceled', at: at(3) },
    ]);
    expect(v.state).toBe('canceled');
    expect(v.filledQuantity.toString()).toBe('4');
    expect(v.filledAt).toBeUndefined();
  });

  it('lets a fill that happened before a cancel complete the order', () => {
    const v = deriveBrokerOrder(new Decimal(4), [
      { eventId: 'c', kind: 'canceled', rawStatus: 'canceled', at: at(3) },
      fill('f1', 2, '4', '100'),
    ]);
    expect(v.state).toBe('filled');
  });

  it('records a rejection with its reason and raw status', () => {
    const v = deriveBrokerOrder(new Decimal(4), [
      { eventId: 'r', kind: 'rejected', rawStatus: 'REJ-17', at: at(1), reason: 'Halted' },
    ]);
    expect(v).toMatchObject({ state: 'rejected', reason: 'Halted', rawStatus: 'REJ-17' });
    expect(v.acknowledgedAt).toBeUndefined();
  });

  it('flags fills beyond the ordered quantity', () => {
    const v = deriveBrokerOrder(new Decimal(4), [fill('a', 1, '3', '1'), fill('b', 2, '3', '1')]);
    expect(v.overfilled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Properties (§17.4): out-of-order and duplicate updates converge.
// ---------------------------------------------------------------------------

const updateArb = (i: number) =>
  fc.oneof(
    fc.record({
      eventId: fc.constant(`e${i}`),
      kind: fc.constant('fill' as const),
      rawStatus: fc.constant('fill'),
      at: fc.integer({ min: 0, max: 59 }).map(at),
      fill: fc.record({
        quantity: fc.integer({ min: 1, max: 5 }).map(String),
        price: fc.integer({ min: 1, max: 500 }).map(String),
        fee: fc.constantFrom('0', '0.5'),
      }),
    }),
    fc.record({
      eventId: fc.constant(`e${i}`),
      kind: fc.constantFrom('accepted', 'canceled', 'rejected', 'expired'),
      rawStatus: fc.string({ maxLength: 8 }),
      at: fc.integer({ min: 0, max: 59 }).map(at),
    }),
  );
const updatesArb = fc
  .integer({ min: 0, max: 8 })
  .chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => updateArb(i))))
  .map((u) => u as BrokerUpdate[]);
const quantityArb = fc.integer({ min: 1, max: 20 }).map((n) => new Decimal(n));

const comparable = (v: ReturnType<typeof deriveBrokerOrder>) => ({
  ...v,
  filledQuantity: v.filledQuantity.toString(),
  averagePrice: v.averagePrice?.toString(),
  fees: v.fees.toString(),
});

describe('broker update properties', () => {
  it('gives the same result for any arrival order and any duplicates', () => {
    fc.assert(
      fc.property(
        quantityArb,
        updatesArb,
        fc.integer(),
        fc.array(fc.nat()),
        (q, updates, seed, dupes) => {
          const shuffled = [...updates].sort(
            (a, b) => ((hash(a.eventId) ^ seed) & 0xffff) - ((hash(b.eventId) ^ seed) & 0xffff),
          );
          const withDupes = [
            ...shuffled,
            ...dupes.flatMap((d) =>
              updates.length ? [updates[d % updates.length] as BrokerUpdate] : [],
            ),
          ];
          expect(comparable(deriveBrokerOrder(q, withDupes))).toEqual(
            comparable(deriveBrokerOrder(q, updates)),
          );
        },
      ),
      { numRuns: 300 },
    );
  });

  it('never leaves a terminal state as more updates arrive', () => {
    fc.assert(
      fc.property(quantityArb, updatesArb, updatesArb, (q, first, more) => {
        const later = more.map((u) => ({ ...u, eventId: `late-${u.eventId}` }));
        const before = deriveBrokerOrder(q, first);
        if (!isTerminalOrderState(before.state)) return;
        expect(isTerminalOrderState(deriveBrokerOrder(q, [...first, ...later]).state)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('counts each distinct fill exactly once and never loses filled quantity', () => {
    fc.assert(
      fc.property(quantityArb, updatesArb, updatesArb, (q, first, more) => {
        const later = more.map((u) => ({ ...u, eventId: `late-${u.eventId}` }));
        const sum = first
          .filter((u) => u.kind === 'fill')
          .reduce((s, u) => s.plus(u.fill?.quantity ?? 0), new Decimal(0));
        const v = deriveBrokerOrder(q, [...first, ...first]);
        expect(v.filledQuantity.toString()).toBe(sum.toString());
        expect(v.overfilled).toBe(sum.gt(q));
        expect(deriveBrokerOrder(q, [...first, ...later]).filledQuantity.gte(sum)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
