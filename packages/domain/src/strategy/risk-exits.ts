import Decimal from 'decimal.js';
import type { PriceAdjustment } from './catalog';
import type {
  ExitRule,
  IndicatorExpr,
  PlannedOrder,
  RiskProfile,
  StrategyDefinition,
} from './schema';

/**
 * ATR-based sizing and the ATR stop (Design v1.2 item 9). Both read the
 * average true range on daily bars of the traded instrument, at the bar the
 * Entry is decided: never later, so nothing looks ahead. A back test reads
 * them on its fill price basis (the run's price adjustment), so the stop level
 * and the closes it is checked against share the entry price's basis.
 */

export type AtrStopRule = Extract<ExitRule, { kind: 'atrStop' }>;

/** ATR(`period`) of an instrument's daily bars, as an expression the engines evaluate. */
export function atrExpr(
  instrumentId: string,
  period: number,
  adjustment: PriceAdjustment = 'split_and_dividend',
): IndicatorExpr {
  return {
    kind: 'indicator',
    id: `atr-${period}-${instrumentId}`,
    name: 'ATR',
    params: { period },
    instrumentId,
    field: 'close',
    interval: '1d',
    adjustment,
    session: 'regular',
    offset: 0,
  };
}

/** The daily close the ATR stop is checked against. */
export function stopCloseExpr(
  instrumentId: string,
  adjustment: PriceAdjustment = 'split_and_dividend',
) {
  return {
    kind: 'market' as const,
    id: `close-${instrumentId}`,
    instrumentId,
    field: 'close' as const,
    interval: '1d' as const,
    adjustment,
    session: 'regular' as const,
    offset: 0,
  };
}

export function atrStopOf(def: StrategyDefinition): AtrStopRule | undefined {
  return def.exit.rules?.find((r): r is AtrStopRule => r.kind === 'atrStop');
}

/** The instrument an ATR stop watches: the first Entry leg's. */
export const atrStopInstrument = (def: StrategyDefinition) => def.entry.orders[0]?.instrumentId;

/** Series ATR sizing and ATR stops read, for loading bars ahead of a run. */
export function riskSeries(
  def: StrategyDefinition,
  adjustment: PriceAdjustment = 'split_and_dividend',
): (IndicatorExpr | ReturnType<typeof stopCloseExpr>)[] {
  const out: (IndicatorExpr | ReturnType<typeof stopCloseExpr>)[] = [];
  for (const p of [def, ...(def.groups ?? [])]) {
    for (const o of p.entry.orders)
      if (o.quantity.type === 'risk_atr' && o.quantity.atrPeriod)
        out.push(atrExpr(o.instrumentId, o.quantity.atrPeriod, adjustment));
    const rule = p.exit.rules?.find((r): r is AtrStopRule => r.kind === 'atrStop');
    const instrument = p.entry.orders[0]?.instrumentId;
    if (rule && instrument) {
      out.push(atrExpr(instrument, rule.atrPeriod, adjustment));
      out.push(stopCloseExpr(instrument, adjustment));
    }
  }
  return out;
}

/**
 * The fixed stop level: entry price ∓ multiple × ATR at entry (minus for a
 * long position, plus for a short one).
 */
export function atrStopLevel(
  entryPrice: Decimal,
  atrAtEntry: Decimal,
  multiple: string,
  long: boolean,
): Decimal {
  const distance = atrAtEntry.times(multiple);
  return long ? entryPrice.minus(distance) : entryPrice.plus(distance);
}

/** Whether a close has crossed the stop: below it for a long, above it for a short. */
export const atrStopHit = (close: Decimal, level: Decimal, long: boolean) =>
  long ? close.lt(level) : close.gt(level);

/** How a risk-based quantity was worked out, shown with each trade so it can be checked by hand. */
export interface RiskSizing {
  method: 'risk_atr';
  equity: string;
  riskPct: string;
  atrPeriod: number;
  atr: string;
  atrMultiple: string;
  /** ATR × multiple: the risk per share. */
  stopDistance: string;
  /** floor(equity × risk% ÷ stop distance), before any cap. */
  riskQuantity: string;
  quantity: string;
  /** Set when an account or strategy limit made the quantity smaller. */
  cappedBy?: 'max_order_size' | 'max_exposure' | 'buying_power';
}

export const isRiskAtr = (o: Pick<PlannedOrder, 'quantity'>) => o.quantity.type === 'risk_atr';

/**
 * The most a risk-sized order may be worth: the tightest of buying power (no
 * leverage), the maximum order size and the room left under the maximum
 * strategy exposure. Risk sizing narrows a position; it never overrides these.
 */
export function riskSizingCap(
  risk: RiskProfile,
  equity: Decimal,
  grossExposure: Decimal,
): { notional: Decimal; by: NonNullable<RiskSizing['cappedBy']> } {
  const options: { notional: Decimal; by: NonNullable<RiskSizing['cappedBy']> }[] = [
    { notional: equity.minus(grossExposure), by: 'buying_power' },
  ];
  if (risk.maxOrderNotional)
    options.push({ notional: new Decimal(risk.maxOrderNotional), by: 'max_order_size' });
  if (risk.maxStrategyExposure)
    options.push({
      notional: new Decimal(risk.maxStrategyExposure).minus(grossExposure),
      by: 'max_exposure',
    });
  return options.reduce((a, b) => (b.notional.lt(a.notional) ? b : a));
}
