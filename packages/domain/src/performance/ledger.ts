import Decimal from 'decimal.js';
import type { Direction } from '../execution/sizing';

/**
 * The trade ledger (Design v1.0 §10; ADR 0019). Fills are matched first in,
 * first out within a book, one book per strategy runtime, account and
 * instrument, so a strategy's lots never close another's. A sell with
 * nothing held opens a short lot; a buy closes short lots first. Fees are
 * shared out by quantity, and a lot's gain or loss belongs to the cycle and
 * leg that opened it, which is how a pair trade shows each leg's part.
 */

export interface LedgerFill {
  id: string;
  /** Book: fills match only within the same runtime, account and instrument. */
  runtimeId: string;
  accountId: string;
  instrumentId: string;
  cycleId: string;
  legLabel: string;
  direction: Direction;
  quantity: Decimal;
  price: Decimal;
  fee: Decimal;
  /** Contract multiplier; 1 for stocks and ETFs. */
  multiplier: Decimal;
  filledAt: Date;
}

export type LotSide = 'long' | 'short';

export interface ClosedLot {
  side: LotSide;
  openFillId: string;
  closeFillId: string;
  runtimeId: string;
  accountId: string;
  instrumentId: string;
  /** The cycle and leg that opened the lot. */
  cycleId: string;
  legLabel: string;
  quantity: Decimal;
  openPrice: Decimal;
  closePrice: Decimal;
  multiplier: Decimal;
  openedAt: Date;
  closedAt: Date;
  gross: Decimal;
  /** The opening and closing fills' fees, in proportion to the quantity matched. */
  fees: Decimal;
  net: Decimal;
}

export interface OpenLot {
  side: LotSide;
  openFillId: string;
  runtimeId: string;
  accountId: string;
  instrumentId: string;
  cycleId: string;
  legLabel: string;
  quantity: Decimal;
  openPrice: Decimal;
  multiplier: Decimal;
  openedAt: Date;
  /** The opening fill's fee for what is still open, charged when it closes. */
  fees: Decimal;
}

export interface Ledger {
  closed: ClosedLot[];
  open: OpenLot[];
}

const ZERO = new Decimal(0);

const bookKey = (f: Pick<LedgerFill, 'runtimeId' | 'accountId' | 'instrumentId'>) =>
  `${f.runtimeId}|${f.accountId}|${f.instrumentId}`;

/** Oldest first; fills at the same instant keep a stable order by id. */
function chronological(a: LedgerFill, b: LedgerFill) {
  return a.filledAt.getTime() - b.filledAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function buildLedger(fills: readonly LedgerFill[]): Ledger {
  const books = new Map<string, OpenLot[]>();
  const closed: ClosedLot[] = [];

  for (const fill of [...fills].sort(chronological)) {
    if (fill.quantity.lte(0)) throw new Error(`Fill ${fill.id} has no quantity`);
    const key = bookKey(fill);
    const lots = books.get(key) ?? [];
    books.set(key, lots);
    // Lots on the other side of this fill are closed first, oldest first.
    const closes: LotSide = fill.direction === 'buy' ? 'short' : 'long';
    const feePerUnit = fill.fee.div(fill.quantity);
    let left = fill.quantity;

    while (left.gt(0) && lots[0]?.side === closes) {
      const lot = lots[0];
      const qty = Decimal.min(left, lot.quantity);
      const share = qty.div(lot.quantity);
      const openFee = lot.fees.times(share);
      const closeFee = feePerUnit.times(qty);
      const move = fill.price.minus(lot.openPrice).times(qty).times(lot.multiplier);
      const gross = lot.side === 'long' ? move : move.neg();
      const fees = openFee.plus(closeFee);
      closed.push({
        side: lot.side,
        openFillId: lot.openFillId,
        closeFillId: fill.id,
        runtimeId: lot.runtimeId,
        accountId: lot.accountId,
        instrumentId: lot.instrumentId,
        cycleId: lot.cycleId,
        legLabel: lot.legLabel,
        quantity: qty,
        openPrice: lot.openPrice,
        closePrice: fill.price,
        multiplier: lot.multiplier,
        openedAt: lot.openedAt,
        closedAt: fill.filledAt,
        gross,
        fees,
        net: gross.minus(fees),
      });
      lot.quantity = lot.quantity.minus(qty);
      lot.fees = lot.fees.minus(openFee);
      if (lot.quantity.isZero()) lots.shift();
      left = left.minus(qty);
    }

    if (left.gt(0)) {
      lots.push({
        side: fill.direction === 'buy' ? 'long' : 'short',
        openFillId: fill.id,
        runtimeId: fill.runtimeId,
        accountId: fill.accountId,
        instrumentId: fill.instrumentId,
        cycleId: fill.cycleId,
        legLabel: fill.legLabel,
        quantity: left,
        openPrice: fill.price,
        multiplier: fill.multiplier,
        openedAt: fill.filledAt,
        fees: feePerUnit.times(left),
      });
    }
  }

  return { closed, open: [...books.values()].flat() };
}

// ---------------------------------------------------------------------------
// Cycle results: one trade per strategy cycle (Phase 5 decision 2).

export interface LegResult {
  legLabel: string;
  accountId: string;
  instrumentId: string;
  side: LotSide;
  /** Quantity opened and the part of it closed. */
  opened: Decimal;
  closed: Decimal;
  averageOpen: Decimal;
  averageClose: Decimal | null;
  gross: Decimal;
  fees: Decimal;
  net: Decimal;
}

export interface CycleResult {
  cycleId: string;
  runtimeId: string;
  openedAt: Date;
  /** When the last of its lots closed; null while any lot is still open. */
  closedAt: Date | null;
  legs: LegResult[];
  gross: Decimal;
  fees: Decimal;
  net: Decimal;
  /** Capital the cycle put to work: the cost of everything it opened. */
  capital: Decimal;
}

interface LegAccumulator {
  leg: LegResult;
  openCost: Decimal;
  closeValue: Decimal;
  capital: Decimal;
}

/**
 * Groups a ledger by the cycle that opened each lot. Realized figures only:
 * open lots count toward `opened` and `capital`, not toward profit or loss.
 */
export function cycleResults(ledger: Ledger): CycleResult[] {
  const cycles = new Map<
    string,
    {
      runtimeId: string;
      openedAt: Date;
      closedAt: Date;
      anyOpen: boolean;
      legs: Map<string, LegAccumulator>;
    }
  >();

  const legFor = (
    lot: Pick<
      OpenLot,
      'cycleId' | 'runtimeId' | 'legLabel' | 'accountId' | 'instrumentId' | 'side' | 'openedAt'
    >,
  ) => {
    let cycle = cycles.get(lot.cycleId);
    if (!cycle) {
      cycle = {
        runtimeId: lot.runtimeId,
        openedAt: lot.openedAt,
        closedAt: lot.openedAt,
        anyOpen: false,
        legs: new Map(),
      };
      cycles.set(lot.cycleId, cycle);
    }
    if (lot.openedAt < cycle.openedAt) cycle.openedAt = lot.openedAt;
    const key = `${lot.legLabel}|${lot.accountId}|${lot.instrumentId}|${lot.side}`;
    let acc = cycle.legs.get(key);
    if (!acc) {
      acc = {
        leg: {
          legLabel: lot.legLabel,
          accountId: lot.accountId,
          instrumentId: lot.instrumentId,
          side: lot.side,
          opened: ZERO,
          closed: ZERO,
          averageOpen: ZERO,
          averageClose: null,
          gross: ZERO,
          fees: ZERO,
          net: ZERO,
        },
        openCost: ZERO,
        closeValue: ZERO,
        capital: ZERO,
      };
      cycle.legs.set(key, acc);
    }
    return { cycle, acc };
  };

  for (const lot of ledger.closed) {
    const { cycle, acc } = legFor(lot);
    const leg = acc.leg;
    leg.opened = leg.opened.plus(lot.quantity);
    leg.closed = leg.closed.plus(lot.quantity);
    leg.gross = leg.gross.plus(lot.gross);
    leg.fees = leg.fees.plus(lot.fees);
    leg.net = leg.net.plus(lot.net);
    acc.openCost = acc.openCost.plus(lot.openPrice.times(lot.quantity));
    acc.capital = acc.capital.plus(lot.openPrice.times(lot.quantity).times(lot.multiplier));
    acc.closeValue = acc.closeValue.plus(lot.closePrice.times(lot.quantity));
    if (lot.closedAt > cycle.closedAt) cycle.closedAt = lot.closedAt;
  }
  for (const lot of ledger.open) {
    const { cycle, acc } = legFor(lot);
    cycle.anyOpen = true;
    acc.leg.opened = acc.leg.opened.plus(lot.quantity);
    acc.openCost = acc.openCost.plus(lot.openPrice.times(lot.quantity));
    acc.capital = acc.capital.plus(lot.openPrice.times(lot.quantity).times(lot.multiplier));
  }

  const results: CycleResult[] = [];
  for (const [cycleId, c] of cycles) {
    const legs = [...c.legs.values()].map(({ leg, openCost, closeValue }) => ({
      ...leg,
      averageOpen: leg.opened.isZero() ? ZERO : openCost.div(leg.opened),
      averageClose: leg.closed.isZero() ? null : closeValue.div(leg.closed),
    }));
    legs.sort((a, b) => (a.legLabel < b.legLabel ? -1 : a.legLabel > b.legLabel ? 1 : 0));
    const sum = (pick: (l: LegResult) => Decimal) => legs.reduce((t, l) => t.plus(pick(l)), ZERO);
    const capital = [...c.legs.values()].reduce((t, a) => t.plus(a.capital), ZERO);
    results.push({
      cycleId,
      runtimeId: c.runtimeId,
      openedAt: c.openedAt,
      closedAt: c.anyOpen ? null : c.closedAt,
      legs,
      gross: sum((l) => l.gross),
      fees: sum((l) => l.fees),
      net: sum((l) => l.net),
      capital,
    });
  }
  return results.sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime());
}
