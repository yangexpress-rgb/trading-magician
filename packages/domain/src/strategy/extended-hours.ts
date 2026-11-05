import type { PlannedOrder } from './schema';

/**
 * Whether a leg can be sent outside the regular session under the "extended
 * hours if supported" market-hours policy (§6.8): a day limit order on an
 * account that trades extended hours. Brokers, Alpaca among them, take
 * extended-hours orders only in that form.
 */
export function extendedHoursEligible(
  order: Pick<PlannedOrder, 'orderType' | 'timeInForce'>,
  accountExtendedHours: boolean,
): boolean {
  return accountExtendedHours && order.orderType === 'limit' && order.timeInForce === 'day';
}
