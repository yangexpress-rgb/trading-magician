import Decimal from 'decimal.js';
import type { PlannedOrder, StrategyDefinition } from '../strategy/schema';
import { isOptionLeg } from '../strategy/schema';
import type { OptionRight } from './pricing';
import { OPTIONS_DEFAULTS } from './trading';

/**
 * Covered calls and cash-secured puts (options brief v0.2 §§5.4, 10; ADR 0123,
 * Phase O3). Shared by validation, the paper runtime and the back test.
 *
 * - A covered call sells calls on shares the same Entry buys: 100 shares for
 *   each call sold, on the same stock and account. Its loss is the shares'
 *   (less the premium taken in), which the equity checks already count.
 * - A cash-secured put sells puts with cash set aside to buy the shares if
 *   assigned: strike × 100 for each put. Its most it can lose is the strike
 *   less the premium, × 100, if the stock goes to 0.
 *
 * Both need options level 1 (§5.4). On the options account (§5.6) the run's
 * own book is the only one, so the shares that cover a call are its own.
 */

export type CoveredKind = 'covered_call' | 'cash_secured_put';

export interface CoveredStructure {
  kind: CoveredKind;
  underlyingId: string;
  accountId: string;
  /** The one options leg, sold to open. */
  option: PlannedOrder;
  /** A covered call's share leg, bought in the same Entry. */
  shares?: PlannedOrder | undefined;
}

const MULT = OPTIONS_DEFAULTS.standardMultiplier;

const units = (o: PlannedOrder) =>
  o.quantity.type === 'units' && /^\d+$/.test(o.quantity.value)
    ? Number(o.quantity.value)
    : undefined;

/**
 * The Entry's covered structures: on an underlying whose only options leg is
 * one call or put sold to open. A call needs a share leg buying 100 shares a
 * contract in the same Entry; a put stands alone. Anything else on the
 * underlying (two or more options legs) is a combo, checked as one (§7.3).
 */
export function coveredStructures(orders: readonly PlannedOrder[]): CoveredStructure[] {
  const out: CoveredStructure[] = [];
  const optionsBy = new Map<string, PlannedOrder[]>();
  for (const o of orders) {
    if (!isOptionLeg(o)) continue;
    const k = `${o.instrumentId}|${o.accountId}`;
    optionsBy.set(k, [...(optionsBy.get(k) ?? []), o]);
  }
  for (const legs of optionsBy.values()) {
    const [o] = legs;
    if (legs.length !== 1 || !o || o.side !== 'sell_short' || !o.option) continue;
    if (o.option.right === 'put') {
      out.push({
        kind: 'cash_secured_put',
        underlyingId: o.instrumentId,
        accountId: o.accountId,
        option: o,
      });
      continue;
    }
    const shares = orders.find(
      (s) =>
        !isOptionLeg(s) &&
        s.side === 'buy' &&
        s.instrumentId === o.instrumentId &&
        s.accountId === o.accountId,
    );
    out.push({
      kind: 'covered_call',
      underlyingId: o.instrumentId,
      accountId: o.accountId,
      option: o,
      shares,
    });
  }
  return out;
}

/** The covered structure a sold-to-open Entry leg belongs to, if any. */
export function coveredOf(
  def: Pick<StrategyDefinition, 'entry'>,
  leg: Pick<PlannedOrder, 'id'>,
): CoveredStructure | undefined {
  return coveredStructures(def.entry.orders).find((s) => s.option.id === leg.id);
}

export type CoveredProblem =
  'options_naked_call' | 'options_uncovered_call' | 'options_covered_size';

/** §7.3 at save time: why this covered structure is refused, or undefined. */
export function coveredStructureProblem(
  s: CoveredStructure,
): { code: CoveredProblem; message: string } | undefined {
  const contracts = units(s.option);
  if (contracts === undefined)
    return {
      code: 'options_covered_size',
      message:
        s.kind === 'covered_call'
          ? `Size "${s.option.legLabel}" in whole contracts, so the shares can cover each call sold`
          : `Size "${s.option.legLabel}" in whole contracts, so the cash it sets aside is known`,
    };
  if (s.kind === 'cash_secured_put') return undefined;
  const shares = s.shares ? units(s.shares) : undefined;
  const needed = contracts * MULT;
  if (!s.shares || shares === undefined || shares < needed)
    return {
      code: s.shares ? 'options_uncovered_call' : 'options_naked_call',
      message: s.shares
        ? `"${s.option.legLabel}" sells ${contracts} call${contracts === 1 ? '' : 's'}, which ${contracts === 1 ? 'needs' : 'need'} ${needed} shares to cover: buy at least ${needed} shares in "${s.shares.legLabel}", sized in shares`
        : `"${s.option.legLabel}" sells a call with no shares to cover it, so its loss has no limit as the price rises: buy 100 shares for each call sold in this Entry, or buy a call (a spread)`,
    };
  return undefined;
}

/**
 * At pricing time, the risk of selling `contracts` options to open alone
 * (§§7.3, 8.1): for a put, the most it can lose (strike less the premium,
 * × 100, at a stock price of 0) and the cash the broker sets aside for an
 * assignment (strike × 100). For a covered call, nothing beyond the shares,
 * which their own order already counts; but it needs those shares held.
 */
export function soldOptionRisk(input: {
  right: OptionRight;
  strike: Decimal.Value;
  contracts: Decimal.Value;
  /** The premium per share the limit takes in. */
  limit: Decimal.Value;
  /** Shares of the underlying the cycle holds, for a call. */
  sharesHeld?: Decimal.Value | undefined;
  multiplier?: Decimal.Value | undefined;
}):
  | { ok: true; atRisk: Decimal; buyingPower: Decimal }
  | { ok: false; code: 'options_uncovered_call'; needed: Decimal; held: Decimal } {
  const n = new Decimal(input.contracts);
  const mult = new Decimal(input.multiplier ?? MULT);
  if (input.right === 'call') {
    const needed = n.times(mult);
    const held = new Decimal(input.sharesHeld ?? 0);
    if (held.lt(needed)) return { ok: false, code: 'options_uncovered_call', needed, held };
    return { ok: true, atRisk: new Decimal(0), buyingPower: new Decimal(0) };
  }
  const k = new Decimal(input.strike);
  return {
    ok: true,
    atRisk: Decimal.max(k.minus(input.limit), 0).times(mult).times(n),
    buyingPower: k.times(mult).times(n),
  };
}

/** Whether the shares of `instrumentId` cover a short call the cycle holds on them. */
export function sharesCoverShortCall(
  positions: ReadonlyMap<string, Decimal>,
  optionOf: (id: string) => { underlyingId: string; right: OptionRight } | undefined,
  instrumentId: string,
): boolean {
  for (const [id, q] of positions) {
    if (!q.lt(0)) continue;
    const o = optionOf(id);
    if (o && o.right === 'call' && o.underlyingId === instrumentId) return true;
  }
  return false;
}
