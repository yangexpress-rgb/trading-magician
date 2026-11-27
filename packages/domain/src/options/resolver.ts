import Decimal from 'decimal.js';
import type { OptionLeg } from '../strategy/schema';
import { daysBetween } from './chain';
import type { OptionRight } from './pricing';
import { contractInWords, OPTIONS_DEFAULTS } from './trading';

/**
 * The contract resolver (options trading brief v0.2 §6, ADR 0123): the one
 * place picker rules are read. The back-test engine and the paper runtime
 * both call it, with the same inputs giving the same contract every time
 * (§6.5). It never widens a rule on its own: no match is a refusal (§6.1.5).
 */

/** One listed contract, as cached in Core (§6.3) or loaded for a back test (§11.2). */
export interface ContractListEntry {
  /** OCC symbol. */
  symbol: string;
  /** YYYY-MM-DD. */
  expiry: string;
  right: OptionRight;
  strike: string;
  /** As the broker reports it; only 100 is standard (§5.3). */
  multiplier: string;
  /** False for an adjusted contract: another deliverable, or a root other than the underlying's. */
  standard: boolean;
  /**
   * Point-in-time (§6.4): the first day the contract is known to have been
   * listed (in a back test, its first daily bar). Absent when not known; a
   * contract listed after the decision date is never seen.
   */
  listedOn?: string | undefined;
}

export interface ResolveInput {
  spec: OptionLeg;
  /** Underlying symbol, for the plain reason. */
  underlying: string;
  /** Current underlying price (the bar's close in a back test). */
  underlyingPrice: Decimal.Value;
  /** Decision date, YYYY-MM-DD (New York): today on paper, the bar's date in a back test. */
  decisionDate: string;
  list: readonly ContractListEntry[];
  /**
   * A combo's one expiry (§3, Phase O2): every leg after the first is resolved
   * on the expiry the first leg chose, or refused if that expiry doesn't list it.
   */
  expiry?: string | undefined;
  /**
   * The delta rule's Greeks (Phase O2): a contract's delta at decision time,
   * signed as the broker reports it, or undefined when not known.
   */
  deltaOf?: ((c: ContractListEntry) => number | undefined) | undefined;
}

export type ResolveRefusal = 'no_price' | 'no_expiry' | 'no_strike' | 'no_list' | 'no_greeks';

export type ResolveResult =
  | { ok: true; contract: ContractListEntry; dte: number; target: string }
  | { ok: false; code: ResolveRefusal; message: string };

const isStandard = (c: ContractListEntry) =>
  c.standard && new Decimal(c.multiplier).eq(OPTIONS_DEFAULTS.standardMultiplier);

/** The strike target of §6.1.2: +p is p% out of the money for both rights. */
export function strikeTarget(
  spec: Pick<OptionLeg, 'right' | 'strikeRule'>,
  price: Decimal.Value,
): Decimal {
  const p = new Decimal(price);
  if (spec.strikeRule.type === 'atm' || spec.strikeRule.type === 'delta') return p;
  const k = new Decimal(spec.strikeRule.pct).div(100);
  return spec.right === 'call' ? p.times(k.plus(1)) : p.times(new Decimal(1).minus(k));
}

export function resolveContract(input: ResolveInput): ResolveResult {
  const { spec, decisionDate } = input;
  const price = new Decimal(input.underlyingPrice);
  const what = `${spec.right} contract`;
  const near =
    spec.strikeRule.type === 'atm'
      ? 'at the money'
      : spec.strikeRule.type === 'delta'
        ? `near ${Math.round(spec.strikeRule.delta * 100)} delta`
        : 'near the target strike';
  const days = `expiring in about ${spec.expiryRule.targetDte} days`;
  const refuse = (code: ResolveRefusal, message: string): ResolveResult => ({
    ok: false,
    code,
    message,
  });
  if (!price.isFinite() || price.lte(0))
    return refuse('no_price', `No ${what} was picked because ${input.underlying} had no price`);
  if (input.list.length === 0)
    return refuse(
      'no_list',
      `No ${what} was picked because no contract list for ${input.underlying} was available`,
    );
  // §6.1.4 and §6.4: standard contracts of this right, listed by the decision date.
  const usable = usableContracts(input.list, spec.right, decisionDate);
  const chosen = chooseExpiry(spec, usable, decisionDate, input.expiry);
  if (!chosen)
    return refuse('no_expiry', `No ${what} ${near} ${days} was available for ${input.underlying}`);
  const strikes = usable.filter((c) => c.expiry === chosen.expiry);
  // Phase O2: the delta rule, on the Greeks known at decision time.
  const rule = spec.strikeRule;
  if (rule.type === 'delta') {
    const known = strikes
      .map((c) => ({ c, d: input.deltaOf?.(c) }))
      .filter((x): x is { c: ContractListEntry; d: number } => x.d !== undefined && isFinite(x.d));
    known.sort((a, b) => {
      const d = Math.abs(Math.abs(a.d) - rule.delta) - Math.abs(Math.abs(b.d) - rule.delta);
      // Tie: closer to the money, which has the larger delta.
      return d !== 0 ? d : Math.abs(b.d) - Math.abs(a.d);
    });
    const best = known[0];
    if (!best)
      return refuse(
        'no_greeks',
        `No ${what} ${near} ${days} was picked because no Greeks were available for ${input.underlying}`,
      );
    return { ok: true, contract: best.c, dte: chosen.dte, target: String(rule.delta) };
  }
  // §6.1.2 and §6.1.3.
  const k = strikeTarget(spec, price);
  strikes.sort((a, b) => {
    const d = new Decimal(a.strike).minus(k).abs().cmp(new Decimal(b.strike).minus(k).abs());
    if (d !== 0) return d;
    // Tie: closer to the money (a call's lower strike, a put's higher).
    const s = new Decimal(a.strike).cmp(new Decimal(b.strike));
    return spec.right === 'call' ? s : -s;
  });
  const contract = strikes[0];
  if (!contract)
    return refuse('no_strike', `No ${what} ${near} ${days} was available for ${input.underlying}`);
  return { ok: true, contract, dte: chosen.dte, target: k.toDecimalPlaces(4).toString() };
}

/**
 * §6.1.1: the expiry nearest `targetDte` that is at least `minDte` days out and
 * never the decision date itself (tie: the later one), or `forced` when it is
 * one of the candidates (a combo's shared expiry).
 */
export function chooseExpiry(
  spec: Pick<OptionLeg, 'expiryRule'>,
  usable: readonly ContractListEntry[],
  decisionDate: string,
  forced?: string | undefined,
): { expiry: string; dte: number } | undefined {
  // No new entry on a contract's expiry date (§8.3), whatever minDte says.
  const minDte = Math.max(1, spec.expiryRule.minDte);
  const expiries = [...new Set(usable.map((c) => c.expiry))]
    .map((e) => ({ expiry: e, dte: daysBetween(decisionDate, e) }))
    .filter((e) => e.dte >= minDte);
  if (forced !== undefined) return expiries.find((e) => e.expiry === forced);
  const target = spec.expiryRule.targetDte;
  expiries.sort((a, b) => {
    const d = Math.abs(a.dte - target) - Math.abs(b.dte - target);
    return d !== 0 ? d : b.dte - a.dte; // tie: the later expiry
  });
  return expiries[0];
}

/** The standard contracts of a right listed by the decision date (§§6.1.4, 6.4). */
export const usableContracts = (
  list: readonly ContractListEntry[],
  right: OptionRight,
  decisionDate: string,
) =>
  list.filter(
    (c) =>
      c.right === right &&
      isStandard(c) &&
      (c.listedOn === undefined || c.listedOn <= decisionDate),
  );

/** "AAPL 105 call, expiring Fri Dec 26" for a resolved contract. */
export const resolvedInWords = (underlying: string, c: ContractListEntry) =>
  contractInWords({ underlying, strike: c.strike, right: c.right, expiry: c.expiry });

/**
 * A stable version of a contract list (§6.3): recorded on the order detail so
 * any pick can be checked later against the list it was made from.
 */
export function contractListVersion(fetchedOn: string, list: readonly ContractListEntry[]): string {
  let h = 2166136261;
  const text = list
    .map((c) => `${c.symbol}|${c.multiplier}|${c.standard ? 1 : 0}`)
    .sort()
    .join(',');
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return `${fetchedOn}:${list.length}:${h.toString(16).padStart(8, '0')}`;
}
