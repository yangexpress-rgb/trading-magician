import Decimal from 'decimal.js';
import type { ExitRule } from '../strategy/schema';
import { daysBetween } from './chain';
import { nyDate, regularSession } from '../market/calendar';
import { OPTIONS_DEFAULTS } from './trading';

/**
 * Option-style exits (options brief v0.2 §8.4, ADR 0123), shared by the back
 * test and the paper runtime: a profit target on the premium and a close at
 * N days to expiry. Both read the contract, never the underlying.
 */

export interface OptionHolding {
  /** What was paid per contract (premium per share, before the multiplier). */
  premiumPaid: Decimal.Value;
  /** What it is worth now, per share: the quote's mid on paper, the bar's close in a back test. */
  premiumNow: Decimal.Value | undefined;
  expiry: string;
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
