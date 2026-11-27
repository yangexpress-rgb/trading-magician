import {
  OPTIONS_BACKTEST_LABEL,
  optionExitReason,
  nyDate,
  resolveContract,
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
  | { ok: false; code: 'option_bars_needed'; symbol: string; message: string };

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
): OptionPick {
  const spec = order.option;
  if (!spec) return { ok: false, code: 'option_contract', message: 'Not an options leg' };
  const all = data.contracts.get(order.instrumentId) ?? [];
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

/** The contract a cycle holds for an Exit leg: its Entry's underlying and right (§5.2). */
export function heldOption(
  positions: ReadonlyMap<string, { quantity: Decimal }>,
  instruments: ReadonlyMap<string, InstrumentRef>,
  order: PlannedOrder,
): string | undefined {
  for (const [id, p] of positions) {
    if (p.quantity.isZero()) continue;
    const o = instruments.get(id)?.option;
    if (o && o.underlyingId === order.instrumentId && o.right === order.option?.right) return id;
  }
  return undefined;
}

/** §8.4 on a back test's bar: premium paid per share and the contract's close now. */
export function optionExitOf(
  rules: readonly ExitRule[] | undefined,
  held: { expiry: string; premiumPaid: Decimal; close: Decimal | undefined }[],
  today: string,
): OptionExitReason | undefined {
  return optionExitReason(
    rules,
    held.map((h) => ({ premiumPaid: h.premiumPaid, premiumNow: h.close, expiry: h.expiry })),
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
