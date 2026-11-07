import type Decimal from 'decimal.js';
import type { RiskProfile } from '../strategy/schema';

/**
 * Pre-trade risk checks (Design v1.0 §8.6). They run immediately before an
 * order is submitted, in the back test and in paper execution alike. Orders
 * that close or reduce a position skip the exposure checks because they lower
 * risk; the active-order cap and the price collar apply to every order.
 */

export const RISK_CHECK_CODES = [
  'risk_active_orders',
  'risk_order_size',
  'risk_exposure',
  'buying_power',
  'risk_daily_loss',
  'risk_drawdown',
  'risk_open_positions',
  'risk_collar',
  'stale_data',
  'market_closed',
] as const;
export type RiskCheckCode = (typeof RISK_CHECK_CODES)[number];

export interface RiskCheckInput {
  risk: RiskProfile;
  closing: boolean;
  quantity: Decimal;
  referencePrice: Decimal;
  limitPrice?: Decimal | undefined;
  /** Orders of this strategy that are still working at the broker. */
  activeOrders: number;
  /** Gross value of the strategy's open positions. */
  grossExposure: Decimal;
  /** Strategy equity, the buying-power ceiling (no leverage). */
  equity: Decimal;
  dailyLossHit: boolean;
  drawdownHit: boolean;
  /** Instruments the strategy holds a non-zero position in. */
  openPositions: number;
  /** Whether the order's instrument is already one of those positions. */
  instrumentHeld: boolean;
  /** Seconds since the reference price was observed; checked when given. */
  priceAgeSec?: number | undefined;
  staleDataSec?: number | undefined;
}

export interface RiskCheckResult {
  ok: boolean;
  /** The first check that failed. */
  code?: RiskCheckCode | undefined;
  /** Every check that ran, in order, for the order's audit record (§8.2). */
  checks: { code: RiskCheckCode; passed: boolean; limit?: string; value?: string }[];
}

export function checkPreTradeRisk(input: RiskCheckInput): RiskCheckResult {
  const { risk, closing, quantity, referencePrice: ref } = input;
  const checks: RiskCheckResult['checks'] = [];
  const done = (): RiskCheckResult => {
    const failed = checks.find((c) => !c.passed);
    return failed ? { ok: false, code: failed.code, checks } : { ok: true, checks };
  };
  const check = (code: RiskCheckCode, passed: boolean, limit?: string, value?: string) => {
    checks.push({
      code,
      passed,
      ...(limit === undefined ? {} : { limit }),
      ...(value === undefined ? {} : { value }),
    });
    return passed;
  };

  if (
    input.priceAgeSec !== undefined &&
    input.staleDataSec !== undefined &&
    !check(
      'stale_data',
      input.priceAgeSec <= input.staleDataSec,
      String(input.staleDataSec),
      String(input.priceAgeSec),
    )
  )
    return done();
  if (
    risk.maxActiveOrders !== undefined &&
    !check(
      'risk_active_orders',
      input.activeOrders < risk.maxActiveOrders,
      String(risk.maxActiveOrders),
      String(input.activeOrders),
    )
  )
    return done();

  if (!closing) {
    const notional = quantity.times(ref);
    if (
      risk.maxOrderNotional &&
      !check(
        'risk_order_size',
        notional.lte(risk.maxOrderNotional),
        risk.maxOrderNotional,
        notional.toFixed(2),
      )
    )
      return done();
    const after = input.grossExposure.plus(notional);
    if (
      risk.maxStrategyExposure &&
      !check(
        'risk_exposure',
        after.lte(risk.maxStrategyExposure),
        risk.maxStrategyExposure,
        after.toFixed(2),
      )
    )
      return done();
    if (!check('buying_power', after.lte(input.equity), input.equity.toFixed(2), after.toFixed(2)))
      return done();
    if (risk.dailyLossLimit && !check('risk_daily_loss', !input.dailyLossHit)) return done();
    if (risk.maxDrawdownPct && !check('risk_drawdown', !input.drawdownHit)) return done();
    if (risk.maxInstrumentsHeld !== undefined && !input.instrumentHeld) {
      if (
        !check(
          'risk_open_positions',
          input.openPositions < risk.maxInstrumentsHeld,
          String(risk.maxInstrumentsHeld),
          String(input.openPositions),
        )
      )
        return done();
    }
  }
  if (risk.priceCollarPct && input.limitPrice) {
    const away = input.limitPrice.minus(ref).abs().div(ref).times(100);
    check(
      'risk_collar',
      away.lte(risk.priceCollarPct),
      risk.priceCollarPct,
      away.toDecimalPlaces(4).toString(),
    );
  }
  return done();
}

/**
 * The price collar on a market order that fills later than it was decided
 * (§7.2, §8.6). The back test fills market orders at the next bar's open and
 * cancels an opening order whose fill moved more than the collar from the
 * price it was decided at. Paper execution does the same for an opening
 * market order decided while the market is closed: it holds the order until
 * the regular session opens, then sends it only if the opening price is still
 * within the collar of its reference price.
 */
export function holdsForOpenCollar(
  order: { side: string; orderType: string; extendedHours: boolean },
  risk: Pick<RiskProfile, 'priceCollarPct'>,
): boolean {
  return (
    !!risk.priceCollarPct &&
    order.orderType === 'market' &&
    !order.extendedHours &&
    (order.side === 'buy' || order.side === 'sell_short')
  );
}

/** How far `price` moved from `reference`, in percent, and whether it is past the collar. */
export function collarBreach(
  reference: Decimal,
  price: Decimal,
  collarPct: string,
): { movePct: Decimal; breached: boolean } {
  const movePct = reference.gt(0)
    ? price.minus(reference).abs().div(reference).times(100)
    : reference.minus(reference);
  return { movePct, breached: reference.gt(0) && movePct.gt(collarPct) };
}
