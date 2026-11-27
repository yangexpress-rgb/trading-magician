import {
  appDelta,
  chooseExpiry,
  OPTIONS_BACKTEST_LABEL,
  optionExitReason,
  nyDate,
  resolveContract,
  usableContracts,
  type Bar,
  type ContractListEntry,
  type ExitRule,
  type OptionExitReason,
  type PlannedOrder,
} from '@tm/domain';
import Decimal from 'decimal.js';
import type { InstrumentRef } from './data';

/**
 * Options in back tests (options brief v0.2 §11, ADR 0123). A strategy whose
 * legs trade options is tested on Alpaca's contract list (active and expired)
 * and each contract's daily trade bars, which Alpaca has from February 2024.
 *
 * - Point in time (A9): on a decision date the resolver sees only contracts
 *   that had traded by then (their first bar on or before it) and expire after
 *   it. A contract's later bars, and contracts listed later, change nothing.
 * - Fills: the contract's next daily bar open, standing in for the mid, ± the
 *   slippage percent of premium (`OPTIONS_FILL_SLIPPAGE_PCT`, default 5%).
 * - Expiry day: whatever is still held closes at that day's close (− slippage);
 *   with no trade that day it settles at its intrinsic value on the
 *   underlying's close: 0 is "Expired worthless", more is "Exercised".
 *
 * Results say they are priced from trade prices, not quotes. Nothing here runs
 * for a strategy without options legs.
 */
export interface OptionsBacktestData {
  /** Every contract of each underlying, active and expired, by underlying instrument id. */
  contracts: ReadonlyMap<string, readonly ContractListEntry[]>;
  /** Daily trade bars of the contracts loaded so far, by OCC symbol, oldest first. */
  bars: ReadonlyMap<string, readonly Bar[]>;
  /** Fill slippage, percent of premium. */
  slippagePct: string;
}

export { OPTIONS_BACKTEST_LABEL };

/** A contract's instrument id inside a back test. */
export const optionInstrumentId = (symbol: string) => `option:${symbol}`;

export function contractRef(underlyingId: string, c: ContractListEntry): InstrumentRef {
  return {
    symbol: c.symbol,
    assetClass: 'option',
    lotSize: '1',
    multiplier: c.multiplier,
    option: { underlyingId, right: c.right, strike: c.strike, expiry: c.expiry },
  };
}

export type OptionPick =
  | { ok: true; contract: ContractListEntry }
  | { ok: false; code: 'option_contract'; message: string }
  /** The picked contract's bars aren't loaded yet: the loader fetches them and runs again. */
  | {
      ok: false;
      code: 'option_bars_needed';
      symbol: string;
      /** The delta rule's other candidates whose bars are needed too (Phase O2). */
      more?: string[] | undefined;
      message: string;
    };

/**
 * The contract an Entry leg buys on `decisionDate` (§6.1), as it was known
 * then: a contract whose bars are loaded counts as listed from its first bar,
 * and a pick whose bars aren't loaded yet is reported, never guessed.
 */
export function pickContract(
  data: OptionsBacktestData,
  order: PlannedOrder,
  underlying: { symbol: string; price: Decimal },
  decisionDate: string,
  /** A combo's shared expiry, chosen by its first leg (Phase O2). */
  expiry?: string,
): OptionPick {
  const spec = order.option;
  if (!spec) return { ok: false, code: 'option_contract', message: 'Not an options leg' };
  const all = data.contracts.get(order.instrumentId) ?? [];
  // Phase O2, the delta rule: each candidate's delta from its own close on or
  // before the decision date (the app's Black-Scholes delta; a back test has
  // no broker Greeks). Candidates whose bars aren't loaded are asked for first.
  let deltaOf: ((c: ContractListEntry) => number | undefined) | undefined;
  if (spec.strikeRule.type === 'delta') {
    const usable = usableContracts(all, spec.right, decisionDate);
    const chosen = chooseExpiry(spec, usable, decisionDate, expiry);
    const candidates = chosen ? usable.filter((c) => c.expiry === chosen.expiry) : [];
    const missing = candidates.filter((c) => !data.bars.has(c.symbol)).map((c) => c.symbol);
    const [first, ...more] = missing;
    if (first)
      return {
        ok: false,
        code: 'option_bars_needed',
        symbol: first,
        more,
        message: `Bars for ${missing.length} contracts are not loaded`,
      };
    deltaOf = (c) => {
      const bars = data.bars.get(c.symbol) ?? [];
      let close: Decimal | undefined;
      for (const b of bars) if (b.start.slice(0, 10) <= decisionDate) close = b.close;
      if (!close) return undefined;
      return appDelta({
        right: c.right,
        strike: c.strike,
        expiry: c.expiry,
        decisionDate,
        price: close,
        underlyingPrice: underlying.price,
      });
    };
  }
  const excluded = new Set<string>();
  // Each round drops a pick that had not traded yet; a handful always settles it.
  for (let round = 0; round < 50; round++) {
    const list = all.filter((c) => !excluded.has(c.symbol));
    const r = resolveContract({
      spec,
      underlying: underlying.symbol,
      underlyingPrice: underlying.price,
      decisionDate,
      list,
      expiry,
      deltaOf,
    });
    if (!r.ok) return { ok: false, code: 'option_contract', message: r.message };
    const bars = data.bars.get(r.contract.symbol);
    if (!bars)
      return {
        ok: false,
        code: 'option_bars_needed',
        symbol: r.contract.symbol,
        message: `Bars for ${r.contract.symbol} are not loaded`,
      };
    const first = bars[0]?.start.slice(0, 10);
    if (first !== undefined && first <= decisionDate) return { ok: true, contract: r.contract };
    excluded.add(r.contract.symbol);
  }
  return {
    ok: false,
    code: 'option_contract',
    message: `No contract near the target had traded by ${decisionDate}`,
  };
}

/**
 * The contract a cycle holds for an Exit leg: its Entry's underlying and
 * right (§5.2), and for a combo (Phase O2) the side it undoes: a sell closes
 * a long contract, a buy to cover a short one. Contracts another Exit leg of
 * this round already closes are passed over.
 */
export function heldOption(
  positions: ReadonlyMap<string, { quantity: Decimal }>,
  instruments: ReadonlyMap<string, InstrumentRef>,
  order: PlannedOrder,
  taken: ReadonlySet<string> = new Set(),
): string | undefined {
  for (const [id, p] of positions) {
    if (p.quantity.isZero() || taken.has(id)) continue;
    if (order.side === 'sell' && p.quantity.lt(0)) continue;
    if (order.side === 'buy_to_cover' && p.quantity.gt(0)) continue;
    const o = instruments.get(id)?.option;
    if (o && o.underlyingId === order.instrumentId && o.right === order.option?.right) return id;
  }
  return undefined;
}

/** §8.4 on a back test's bar: premium paid per share and the contract's close now. */
export function optionExitOf(
  rules: readonly ExitRule[] | undefined,
  held: {
    expiry: string;
    premiumPaid: Decimal;
    close: Decimal | undefined;
    /** A combo's legs (Phase O2): its target reads the combo whole. */
    right?: 'call' | 'put' | undefined;
    strike?: string | undefined;
    quantity?: Decimal | undefined;
  }[],
  today: string,
): OptionExitReason | undefined {
  return optionExitReason(
    rules,
    held.map((h) => ({
      premiumPaid: h.premiumPaid,
      premiumNow: h.close,
      expiry: h.expiry,
      ...(h.quantity !== undefined
        ? { right: h.right, strike: h.strike, quantity: h.quantity }
        : {}),
    })),
    today,
  );
}

/** A contract's value at expiry per share: what it is in the money by on the underlying's close. */
export function intrinsicValue(
  option: { right: 'call' | 'put'; strike: string },
  underlyingClose: Decimal,
): Decimal {
  const k = new Decimal(option.strike);
  const v = option.right === 'call' ? underlyingClose.minus(k) : k.minus(underlyingClose);
  return Decimal.max(v, 0);
}

/** Converts Alpaca's daily option bars (t, o, h, l, c, v) to engine bars on the NYSE day. */
export function optionDailyBars(
  rows: readonly { t: string; o: number; h: number; l: number; c: number; v: number }[],
  sessionOf: (date: string) => { open: string; close: string } | undefined,
): Bar[] {
  const out: Bar[] = [];
  for (const r of rows) {
    // Alpaca stamps a daily bar at midnight New York time; noon is safely inside the day.
    const date = nyDate(new Date(Date.parse(r.t) + 12 * 3_600_000));
    const s = sessionOf(date);
    if (!s) continue;
    out.push({
      start: s.open,
      end: s.close,
      open: new Decimal(r.o),
      high: new Decimal(r.h),
      low: new Decimal(r.l),
      close: new Decimal(r.c),
      volume: new Decimal(r.v),
    });
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}
