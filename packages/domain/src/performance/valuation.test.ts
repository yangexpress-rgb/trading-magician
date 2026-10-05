import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { buildLedger, type LedgerFill } from './ledger';
import { markFromQuote, totalBooks, valuationSession, valueBooks, type Mark } from './valuation';

const d = (v: string | number) => new Decimal(v);
const at = (minute: number) => new Date(Date.UTC(2026, 9, 6, 14, minute));
let n = 0;
const fill = (
  p: Partial<LedgerFill> & Pick<LedgerFill, 'direction' | 'quantity' | 'price'>,
): LedgerFill => ({
  id: `v${++n}`,
  runtimeId: 'rt',
  accountId: 'acct',
  instrumentId: 'A',
  cycleId: 'c1',
  legLabel: 'Leg',
  fee: d(0),
  multiplier: d(1),
  filledAt: at(n),
  ...p,
});
const mark = (price: number, stale = false): Mark => ({ price: d(price), at: at(59), stale });

describe('valueBooks', () => {
  it('marks longs and shorts and keeps realized apart', () => {
    const ledger = buildLedger([
      fill({ direction: 'buy', quantity: d(10), price: d(100), fee: d(1) }),
      fill({ direction: 'sell', quantity: d(4), price: d(110) }),
      fill({ direction: 'sell', quantity: d(5), price: d(50), instrumentId: 'B' }),
    ]);
    const books = valueBooks(
      ledger,
      new Map([
        ['A', mark(105)],
        ['B', mark(48)],
      ]),
    );
    const a = books.find((b) => b.instrumentId === 'A')!;
    expect([a.quantity, a.costBasis, a.marketValue, a.unrealized].map(String)).toEqual([
      '6',
      '600',
      '630',
      '30',
    ]);
    expect(a.realized.toString()).toBe('39.6'); // 40 gross less 0.40 of the opening fee
    expect(a.openFees.toString()).toBe('0.6');
    const b = books.find((x) => x.instrumentId === 'B')!;
    expect([b.quantity, b.marketValue, b.unrealized].map(String)).toEqual(['-5', '-240', '10']);
    const t = totalBooks(books);
    expect(t.pnl.toString()).toBe('79'); // 39.6 + 30 + 10 - 0.6
    expect(t.staleMarks).toBe(0);
  });

  it('counts books with a stale or missing price', () => {
    const ledger = buildLedger([
      fill({ direction: 'buy', quantity: d(1), price: d(10) }),
      fill({ direction: 'buy', quantity: d(1), price: d(10), instrumentId: 'B' }),
    ]);
    const books = valueBooks(ledger, new Map([['A', mark(11, true)]]));
    expect(totalBooks(books).staleMarks).toBe(2);
    expect(books.find((b) => b.instrumentId === 'B')!.mark).toBeNull();
  });
});

describe('valuationSession', () => {
  it('is today once the session opens and final from the close', () => {
    expect(valuationSession(new Date('2026-10-06T15:00:00Z'))).toMatchObject({
      date: '2026-10-06',
      final: false,
    });
    expect(valuationSession(new Date('2026-10-06T20:00:00Z'))).toMatchObject({
      date: '2026-10-06',
      final: true,
    });
  });

  it('is the previous session before the open, over weekends and holidays', () => {
    expect(valuationSession(new Date('2026-10-07T12:00:00Z')).date).toBe('2026-10-06');
    expect(valuationSession(new Date('2026-10-11T15:00:00Z')).date).toBe('2026-10-09');
    // Thanksgiving 2026 is Thursday 26 November.
    expect(valuationSession(new Date('2026-11-26T18:00:00Z')).date).toBe('2026-11-25');
  });
});

describe('markFromQuote', () => {
  // 2026-10-06 closes at 20:00 UTC.
  const close = '2026-10-06T20:00:00.000Z';
  const quote = (iso: string) => ({ last: d(12.5), at: iso });

  it('is fresh within a minute while the market is open', () => {
    const m = markFromQuote(quote('2026-10-06T15:00:00Z'), new Date('2026-10-06T15:00:59Z'), close);
    expect(m).toMatchObject({ stale: false });
    expect(m.price.toString()).toBe('12.5');
  });

  it('is stale when the price stopped more than a minute ago', () => {
    expect(
      markFromQuote(quote('2026-10-06T15:00:00Z'), new Date('2026-10-06T15:01:01Z'), close).stale,
    ).toBe(true);
  });

  it('keeps the closing price fresh after the close, but not one that stopped early', () => {
    const later = new Date('2026-10-06T23:00:00Z');
    expect(markFromQuote(quote('2026-10-06T19:59:30Z'), later, close).stale).toBe(false);
    expect(markFromQuote(quote('2026-10-06T19:30:00Z'), later, close).stale).toBe(true);
  });
});
