import type Decimal from 'decimal.js';
import { nyDate, regularSession } from '../market/calendar';
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
  'risk_account_exposure',
  'risk_pilot_order',
  'risk_pilot_exposure',
  'buying_power',
  'risk_daily_loss',
  'risk_drawdown',
  'risk_open_positions',
  'risk_collar',
  'stale_data',
  'market_closed',
] as const;
export type RiskCheckCode = (typeof RISK_CHECK_CODES)[number];

/**
 * Checks that refuse an order because the strategy or account is full, not
 * because anything is wrong with the order. They clear on their own as
 * positions close, so they do not count toward the rejections-in-a-row pause
 * (N300, ADR 0102): a Selection that picks more names than its exposure limit
 * holds would otherwise pause itself every time it ranks.
 */
export const CAPACITY_RISK_CODES = [
  'risk_active_orders',
  'risk_exposure',
  'risk_account_exposure',
  'risk_pilot_exposure',
  'buying_power',
  'risk_open_positions',
] as const satisfies readonly RiskCheckCode[];

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
  /**
   * The account's own exposure limit (Phase 7 P1, ADR 0107): the gross value
   * every run on the account holds and has working, before this order.
   */
  account?:
    | {
        /** The account's own maximum, when it has one. */
        maxExposure?: string | undefined;
        grossExposure: Decimal;
        /**
         * A live account's pilot caps (Phase 7 P3, ADR 0109): the most one opening
         * order may be worth, and the most the account may hold and have working.
         */
        pilot?: { maxOrder: string; maxExposure: string } | undefined;
      }
    | undefined;
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
    if (input.account) {
      const { pilot, maxExposure } = input.account;
      const accountAfter = input.account.grossExposure.plus(notional);
      if (
        maxExposure &&
        !check(
          'risk_account_exposure',
          accountAfter.lte(maxExposure),
          maxExposure,
          accountAfter.toFixed(2),
        )
      )
        return done();
      if (
        pilot &&
        !check(
          'risk_pilot_order',
          notional.lte(pilot.maxOrder),
          pilot.maxOrder,
          notional.toFixed(2),
        )
      )
        return done();
      if (
        pilot &&
        !check(
          'risk_pilot_exposure',
          accountAfter.lte(pilot.maxExposure),
          pilot.maxExposure,
          accountAfter.toFixed(2),
        )
      )
        return done();
    }
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
 * The price collar on an opening market order decided while the regular
 * session is closed (§7.2, §8.6, N325). Paper execution holds such an order
 * (Ready) until the session opens instead of sending it at once. The collar
 * then guards the seconds between releasing it and sending it, never the gap
 * since it was decided: see `collarAtRelease`.
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

/** A price the collar compares, with when it was sampled and what it is (N325). */
export interface CollarSample {
  price: Decimal;
  /** Provider timestamp, ISO 8601 UTC. */
  at: string;
  source: 'release_snapshot' | 'send_attempt';
}

export const COLLAR_SOURCE_TEXT: Record<CollarSample['source'], string> = {
  release_snapshot: 'release snapshot',
  send_attempt: 'at the send attempt',
};

/** What to do with a held order at the open (N325). */
export type CollarRelease =
  | { kind: 'wait' }
  | { kind: 'send'; anchor: CollarSample; price: CollarSample; movePct: Decimal }
  | {
      kind: 'block';
      anchor: CollarSample;
      price: CollarSample;
      movePct: Decimal;
      /** The reason shown to the person, naming both prices and when each was sampled. */
      reason: string;
    };

/**
 * Whether a price was sampled in the regular session open at `now`: on or after
 * that session's open and not after `now`. A price from any earlier session
 * (Friday's close, a pre-market quote) is not.
 */
export function sampledInSessionAt(at: string, now: number): boolean {
  const session = regularSession(nyDate(new Date(now)));
  if (!session) return false;
  const t = Date.parse(at);
  return (
    Number.isFinite(t) && t >= Date.parse(session.open) && t < Date.parse(session.close) && t <= now
  );
}

const etTime = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
});

/** "9:30:01 AM ET". */
export function formatCollarTime(at: string): string {
  return `${etTime.format(new Date(at))} ET`;
}

/**
 * The price collar for an order released at the open (N325, ADR 0113). Its
 * anchor is the release snapshot, the freshest price the worker has when it
 * releases the order, which must be from the session the order is sent in; the
 * price compared with it is read again at the send attempt, seconds later at
 * most. The price the order was decided at plays no part: an order held for the
 * open was decided in an earlier session by construction, and the move since
 * then is the market's ordinary move across sessions, not an anomaly.
 *
 * Waits (sends nothing yet) while either price is missing or is not from the
 * current session.
 */
export function collarAtRelease(input: {
  snapshot: { last: Decimal; at: string } | undefined;
  sendQuote: { last: Decimal; at: string } | undefined;
  now: number;
  collarPct: string;
}): CollarRelease {
  const { snapshot, sendQuote, now, collarPct } = input;
  if (!snapshot || !sampledInSessionAt(snapshot.at, now)) return { kind: 'wait' };
  if (!sendQuote || !sampledInSessionAt(sendQuote.at, now)) return { kind: 'wait' };
  const anchor: CollarSample = {
    price: snapshot.last,
    at: snapshot.at,
    source: 'release_snapshot',
  };
  const price: CollarSample = { price: sendQuote.last, at: sendQuote.at, source: 'send_attempt' };
  const { movePct, breached } = collarBreach(anchor.price, price.price, collarPct);
  if (!breached) return { kind: 'send', anchor, price, movePct };
  const reason =
    `Not sent: the price moved ${movePct.toFixed(1)}% while the order was being sent, ` +
    `from $${anchor.price.toFixed(2)} at ${formatCollarTime(anchor.at)} ` +
    `(${COLLAR_SOURCE_TEXT[anchor.source]}) ` +
    `to $${price.price.toFixed(2)} at ${formatCollarTime(price.at)} ` +
    `(${COLLAR_SOURCE_TEXT[price.source]}). The price collar allows ${collarPct}%.`;
  return { kind: 'block', anchor, price, movePct, reason };
}

/** Each pre-trade check in words, for notifications (N287). */
export const RISK_CHECK_TEXT: Record<RiskCheckCode, string> = {
  risk_active_orders: 'Active orders',
  risk_order_size: 'Order size',
  risk_exposure: 'Strategy exposure',
  risk_account_exposure: 'Account exposure',
  risk_pilot_order: 'Pilot cap per order',
  risk_pilot_exposure: 'Pilot cap on exposure',
  buying_power: 'Buying power',
  risk_daily_loss: 'Daily loss',
  risk_drawdown: 'Drawdown',
  risk_open_positions: 'Open positions',
  risk_collar: 'Price collar',
  stale_data: 'Price age',
  market_closed: 'Market hours',
};

const DOLLAR_CHECKS: readonly RiskCheckCode[] = [
  'risk_order_size',
  'risk_exposure',
  'risk_account_exposure',
  'risk_pilot_order',
  'risk_pilot_exposure',
  'buying_power',
];

const dollars = (v: string) =>
  `$${Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

/**
 * Why the risk check refused an order, in words, with the figures it compared
 * (N287), e.g. "Active orders: 20 already working, limit 20". Null when it passed.
 */
export function riskRefusalText(
  result: Pick<RiskCheckResult, 'ok' | 'code' | 'checks'> | null | undefined,
): string | null {
  if (!result || result.ok) return null;
  const code = result.code;
  const label = code ? (RISK_CHECK_TEXT[code] ?? code) : 'a check failed';
  const failed = result.checks.find((c) => c.code === code && !c.passed);
  if (!code || !failed || failed.limit === undefined || failed.value === undefined) return label;
  const { value, limit } = failed;
  let detail: string;
  if (code === 'risk_active_orders') detail = `${value} already working, limit ${limit}`;
  else if (code === 'risk_open_positions') detail = `${value} held, limit ${limit}`;
  else if (code === 'stale_data') detail = `price ${value} s old, limit ${limit} s`;
  else if (code === 'risk_collar')
    detail = `limit price ${Number(value).toFixed(1)}% away, limit ${limit}%`;
  else if (DOLLAR_CHECKS.includes(code)) detail = `${dollars(value)}, limit ${dollars(limit)}`;
  else detail = `${value}, limit ${limit}`;
  return `${label}: ${detail}`;
}
