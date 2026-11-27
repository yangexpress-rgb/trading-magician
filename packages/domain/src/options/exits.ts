import Decimal from 'decimal.js';
import type { ExitRule } from '../strategy/schema';
import { daysBetween } from './chain';
import { nyDate, regularSession } from '../market/calendar';
import { OPTIONS_DEFAULTS } from './trading';
import { comboMaxProfit } from './combo';
import type { OptionRight } from './pricing';

/**
 * Option-style exits (options brief v0.2 §8.4, ADR 0123), shared by the back
 * test and the paper runtime: a profit target on the premium and a close at
 * N days to expiry. Both read the contract, never the underlying.
 */

export interface OptionHolding {
  /** What was paid per contract (premium per share, before the multiplier); received, for a short leg. */
  premiumPaid: Decimal.Value;
  /** What it is worth now, per share: the quote's mid on paper, the bar's close in a back test. */
  premiumNow: Decimal.Value | undefined;
  expiry: string;
  /**
   * Phase O2: a combo leg's place in the combo. When a cycle holds a combo
   * (any holding with these), the profit target reads the combo as a whole, as
   * a percent of its max profit (§8.4).
   */
  right?: OptionRight | undefined;
  strike?: Decimal.Value | undefined;
  /** Signed contracts held: negative for a leg sold to open. */
  quantity?: Decimal.Value | undefined;
}

/**
 * A combo's profit now as a percent of its max profit at the net price paid
 * (§8.4), or of the net premium when its profit has no ceiling. Undefined when
 * a leg has no price now.
 */
export function comboTargetPct(holdings: readonly OptionHolding[]): Decimal | undefined {
  if (holdings.some((h) => h.premiumNow === undefined)) return undefined;
  const legs = holdings.map((h) => ({
    right: h.right ?? 'call',
    strike: h.strike ?? 0,
    quantity: new Decimal(h.quantity ?? 1).toNumber(),
  }));
  const paid = holdings.reduce(
    (s, h, i) => s.plus(new Decimal(h.premiumPaid).times(legs[i]?.quantity ?? 0)),
    new Decimal(0),
  );
  const now = holdings.reduce(
    (s, h, i) => s.plus(new Decimal(h.premiumNow ?? 0).times(legs[i]?.quantity ?? 0)),
    new Decimal(0),
  );
  const gain = now.minus(paid);
  const ceiling = comboMaxProfit(legs, paid, 1);
  const base = ceiling ?? paid.abs();
  if (!base.gt(0)) return undefined;
  return gain.div(base).times(100);
}

export type OptionExitReason = 'option_target' | 'option_dte';

/** The first option exit rule that fires for any holding, or undefined. */
export function optionExitReason(
  rules: readonly ExitRule[] | undefined,
  holdings: readonly OptionHolding[],
  today: string,
): OptionExitReason | undefined {
  if (!rules?.length || holdings.length === 0) return undefined;
  for (const r of rules) {
    if (r.kind === 'optionDte' && holdings.some((h) => daysBetween(today, h.expiry) <= r.days))
      return 'option_dte';
    if (r.kind === 'optionTarget') {
      if (holdings.some((h) => h.quantity !== undefined && h.right !== undefined)) {
        const pct = comboTargetPct(holdings);
        if (pct?.gte(r.pct)) return 'option_target';
        continue;
      }
      const hit = holdings.some((h) => {
        const paid = new Decimal(h.premiumPaid);
        if (h.premiumNow === undefined || !paid.gt(0)) return false;
        return new Decimal(h.premiumNow).minus(paid).div(paid).times(100).gte(r.pct);
      });
      if (hit) return 'option_target';
    }
  }
  return undefined;
}

/**
 * §8.3 Expiry day: where a held contract stands at `now`. `close` from 15:00
 * New York time on its expiry day (a limit at the mid), `touch` from 15:20
 * (at the bid to sell, the ask to buy), `expired` once its expiry day is past.
 * An early-close day moves both times back by the same distance to the close.
 */
export type ExpiryStage = 'none' | 'close' | 'touch' | 'expired';

export function expiryStage(expiry: string, now: Date): ExpiryStage {
  const today = nyDate(now);
  if (today > expiry) return 'expired';
  if (today < expiry) return 'none';
  const session = regularSession(expiry);
  if (!session) return 'none';
  const closeAt = Date.parse(session.close);
  // 16:00 − 15:00 = 60 minutes and 16:00 − 15:20 = 40 minutes before the close.
  const at = (wall: string) => {
    const [h, m] = wall.split(':').map(Number) as [number, number];
    return closeAt - ((16 - h) * 60 - m) * 60_000;
  };
  const t = now.getTime();
  if (t >= at(OPTIONS_DEFAULTS.closeOutTouch)) return 'touch';
  if (t >= at(OPTIONS_DEFAULTS.closeOutStart)) return 'close';
  return 'none';
}

/**
 * §7.5 (Phase O2), the dividend watch: a short call in the money whose time
 * value (its mid less what it is worth exercised) is below the dividend is
 * likely to be exercised the day before the ex-date, so the holder collects
 * the dividend. Then the combo closes first. Undefined price data: no.
 */
export function dividendExerciseLikely(input: {
  strike: Decimal.Value;
  /** The call's mid now, per share. */
  mid: Decimal.Value | undefined;
  underlyingPrice: Decimal.Value | undefined;
  /** Cash per share. */
  dividend: Decimal.Value;
}): boolean {
  if (input.mid === undefined || input.underlyingPrice === undefined) return false;
  const intrinsic = new Decimal(input.underlyingPrice).minus(input.strike);
  if (!intrinsic.gt(0)) return false;
  return new Decimal(input.mid).minus(intrinsic).lt(input.dividend);
}

/** §8.3 (Phase O2): how near the money a short leg is closed a day before its expiry. */
export const SHORT_NEAR_MONEY_PCT = 2;

/** Whether a short leg's strike is within 2% of the underlying's price (§8.3). */
export function shortNearTheMoney(strike: Decimal.Value, underlyingPrice: Decimal.Value): boolean {
  const s = new Decimal(underlyingPrice);
  if (!s.gt(0)) return false;
  return new Decimal(strike).minus(s).abs().div(s).times(100).lte(SHORT_NEAR_MONEY_PCT);
}
