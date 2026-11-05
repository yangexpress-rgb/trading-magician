import Decimal from 'decimal.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildLedger, cycleResults, type LedgerFill } from './ledger';

const d = (v: string | number) => new Decimal(v);
let seq = 0;
const at = (minute: number) => new Date(Date.UTC(2026, 9, 6, 14, minute));

function fill(
  partial: Partial<LedgerFill> & Pick<LedgerFill, 'direction' | 'quantity' | 'price'>,
): LedgerFill {
  seq += 1;
  return {
    id: `f${String(seq).padStart(4, '0')}`,
    runtimeId: 'rt-1',
    accountId: 'acct-1',
    instrumentId: 'ZTSTA',
    cycleId: 'c1',
    legLabel: 'Long A',
    fee: d(0),
    multiplier: d(1),
    filledAt: at(seq),
    ...partial,
  };
}

describe('buildLedger', () => {
  it('matches sells to the oldest buys first', () => {
    const ledger = buildLedger([
      fill({ direction: 'buy', quantity: d(10), price: d(100) }),
      fill({ direction: 'buy', quantity: d(10), price: d(110) }),
      fill({ direction: 'sell', quantity: d(15), price: d(120) }),
    ]);
    expect(
      ledger.closed.map((l) => [l.quantity.toString(), l.openPrice.toString(), l.gross.toString()]),
    ).toEqual([
      ['10', '100', '200'],
      ['5', '110', '50'],
    ]);
    expect(ledger.open).toHaveLength(1);
    expect(ledger.open[0]).toMatchObject({ side: 'long' });
    expect(ledger.open[0]!.quantity.toString()).toBe('5');
  });

  it('opens and covers shorts, gaining when the price falls', () => {
    const ledger = buildLedger([
      fill({ direction: 'sell', quantity: d(20), price: d(50), legLabel: 'Short B' }),
      fill({ direction: 'buy', quantity: d(20), price: d(45), legLabel: 'Cover B' }),
    ]);
    expect(ledger.open).toEqual([]);
    expect(ledger.closed[0]).toMatchObject({ side: 'short', legLabel: 'Short B' });
    expect(ledger.closed[0]!.gross.toString()).toBe('100');
  });

  it('flips through flat: a sell larger than the holding opens a short with the rest', () => {
    const ledger = buildLedger([
      fill({ direction: 'buy', quantity: d(5), price: d(10) }),
      fill({ direction: 'sell', quantity: d(8), price: d(12) }),
    ]);
    expect(ledger.closed[0]!.gross.toString()).toBe('10');
    expect(ledger.open[0]).toMatchObject({ side: 'short' });
    expect(ledger.open[0]!.quantity.toString()).toBe('3');
  });

  it('shares fees by quantity between the lots a fill touches', () => {
    const ledger = buildLedger([
      fill({ direction: 'buy', quantity: d(10), price: d(100), fee: d('1.00') }),
      fill({ direction: 'sell', quantity: d(4), price: d(101), fee: d('0.40') }),
    ]);
    // 4 of 10 opened: 0.40 of the opening fee, plus the whole closing fee.
    expect(ledger.closed[0]!.fees.toString()).toBe('0.8');
    expect(ledger.closed[0]!.net.toString()).toBe('3.2');
    expect(ledger.open[0]!.fees.toString()).toBe('0.6');
  });

  it('keeps books apart: one strategy never closes another’s lots', () => {
    const ledger = buildLedger([
      fill({ direction: 'buy', quantity: d(10), price: d(100), runtimeId: 'rt-1' }),
      fill({ direction: 'sell', quantity: d(10), price: d(90), runtimeId: 'rt-2' }),
    ]);
    expect(ledger.closed).toEqual([]);
    expect(ledger.open.map((l) => [l.runtimeId, l.side])).toEqual([
      ['rt-1', 'long'],
      ['rt-2', 'short'],
    ]);
  });

  it('applies the contract multiplier', () => {
    const ledger = buildLedger([
      fill({ direction: 'buy', quantity: d(1), price: d('2.50'), multiplier: d(100) }),
      fill({ direction: 'sell', quantity: d(1), price: d('3.00'), multiplier: d(100) }),
    ]);
    expect(ledger.closed[0]!.gross.toString()).toBe('50');
  });
});

describe('cycleResults', () => {
  it('reports a pair trade as one result with each leg’s part', () => {
    const results = cycleResults(
      buildLedger([
        fill({ direction: 'buy', quantity: d(10), price: d(100), legLabel: 'Long A' }),
        fill({
          direction: 'sell',
          quantity: d(20),
          price: d(50),
          legLabel: 'Short B',
          instrumentId: 'ZTSTB',
        }),
        fill({ direction: 'sell', quantity: d(10), price: d(97), legLabel: 'Sell A' }),
        fill({
          direction: 'buy',
          quantity: d(20),
          price: d(48),
          legLabel: 'Cover B',
          instrumentId: 'ZTSTB',
        }),
      ]),
    );
    expect(results).toHaveLength(1);
    const [cycle] = results;
    expect(cycle!.net.toString()).toBe('10');
    expect(cycle!.closedAt).not.toBeNull();
    expect(cycle!.capital.toString()).toBe('2000');
    expect(cycle!.legs.map((l) => [l.legLabel, l.side, l.net.toString()])).toEqual([
      ['Long A', 'long', '-30'],
      ['Short B', 'short', '40'],
    ]);
    expect(cycle!.legs[0]!.averageClose?.toString()).toBe('97');
  });

  it('leaves a cycle open while any of its lots is open', () => {
    const [cycle] = cycleResults(
      buildLedger([
        fill({ direction: 'buy', quantity: d(10), price: d(100) }),
        fill({ direction: 'sell', quantity: d(6), price: d(105) }),
      ]),
    );
    expect(cycle!.closedAt).toBeNull();
    expect(cycle!.net.toString()).toBe('30');
    expect(cycle!.legs[0]!.opened.toString()).toBe('10');
    expect(cycle!.legs[0]!.closed.toString()).toBe('6');
  });
});

describe('ledger properties', () => {
  const fills = fc.array(
    fc.record({
      buy: fc.boolean(),
      qty: fc.integer({ min: 1, max: 50 }),
      price: fc.integer({ min: 1, max: 500 }),
      fee: fc.integer({ min: 0, max: 5 }),
      book: fc.constantFrom('rt-1', 'rt-2'),
    }),
    { maxLength: 40 },
  );
  const toFills = (
    rows: { buy: boolean; qty: number; price: number; fee: number; book: string }[],
  ) =>
    rows.map((r, i) =>
      fill({
        id: `p${String(i).padStart(4, '0')}`,
        filledAt: at(i),
        runtimeId: r.book,
        direction: r.buy ? 'buy' : 'sell',
        quantity: d(r.qty),
        price: d(r.price),
        fee: d(r.fee),
      }),
    );

  it('keeps each book’s net position equal to buys minus sells', () => {
    fc.assert(
      fc.property(fills, (rows) => {
        const all = toFills(rows);
        const ledger = buildLedger(all);
        for (const book of ['rt-1', 'rt-2']) {
          const net = all
            .filter((f) => f.runtimeId === book)
            .reduce(
              (t, f) => (f.direction === 'buy' ? t.plus(f.quantity) : t.minus(f.quantity)),
              d(0),
            );
          const open = ledger.open
            .filter((l) => l.runtimeId === book)
            .reduce((t, l) => (l.side === 'long' ? t.plus(l.quantity) : t.minus(l.quantity)), d(0));
          expect(open.toString()).toBe(net.toString());
          // A book holds lots on one side only.
          expect(
            new Set(ledger.open.filter((l) => l.runtimeId === book).map((l) => l.side)).size,
          ).toBeLessThanOrEqual(1);
        }
      }),
    );
  });

  it('accounts for every fee and, once flat, every dollar', () => {
    fc.assert(
      fc.property(fills, (rows) => {
        const all = toFills(rows);
        const ledger = buildLedger(all);
        const fees = all.reduce((t, f) => t.plus(f.fee), d(0));
        const charged = ledger.closed.reduce((t, l) => t.plus(l.fees), d(0));
        const pending = ledger.open.reduce((t, l) => t.plus(l.fees), d(0));
        expect(charged.plus(pending).toDecimalPlaces(10).toString()).toBe(fees.toString());
        if (ledger.open.length === 0) {
          // Flat: realized gross is exactly sales minus purchases.
          const cash = all.reduce(
            (t, f) =>
              f.direction === 'sell'
                ? t.plus(f.price.times(f.quantity))
                : t.minus(f.price.times(f.quantity)),
            d(0),
          );
          const gross = ledger.closed.reduce((t, l) => t.plus(l.gross), d(0));
          expect(gross.toString()).toBe(cash.toString());
        }
      }),
    );
  });
});
