import type { OrderSide, OrderType, PhaseName, PlannedOrder } from '../strategy/schema';
import type { RiskCheckResult } from './risk';
import type { Direction } from './sizing';

/**
 * An immutable order intent (Design v1.0 §8.2): what the app decided to send,
 * and why. Broker identity, acknowledgments and fills are recorded beside it
 * and never overwrite it.
 */
export interface OrderIntent {
  runtimeId: string;
  strategyId: string;
  versionId: string;
  cycleId: string;
  phase: PhaseName;
  /** The planned order's id in the strategy version; absent for system orders. */
  plannedOrderId: string | undefined;
  /** Entry batch or Exit round; part of the idempotency key. */
  attempt: number;
  legLabel: string;
  triggerEventId: string | undefined;
  scheduledActionId: string | undefined;
  /** When the timing rule made the order eligible, ISO 8601 UTC. */
  eligibleAt: string;
  accountId: string;
  instrumentId: string;
  side: OrderSide;
  direction: Direction;
  quantity: string;
  orderType: OrderType;
  limitPrice: string | undefined;
  stopPrice: string | undefined;
  timeInForce: PlannedOrder['timeInForce'];
  extendedHours: boolean;
  referencePrice: string;
  risk: RiskCheckResult;
  idempotencyKey: string;
  /** Whether a person or the strategy created the order (§14.3). */
  source: 'strategy' | 'user' | 'system';
  /**
   * Why the app closed on its own, in words (N306). Required for a safety
   * close (`source: 'system'`); recording one without it is refused.
   */
  closeReason?: string | undefined;
  /** The data feed whose price `referencePrice` is (ADR 0108), when it came through one. */
  pricedByFeedId?: string | undefined;
  /** Options orders only (ADR 0123): how the contract and the limit were chosen. */
  optionDetail?: OptionOrderDetail | undefined;
  /** An options combo's own client order id, shared by its legs' intents (Phase O2). */
  orderGroupId?: string | undefined;
}

/** What an options order's detail shows (options brief v0.2 §§6.2, 6.3, 7.1, 9). */
export interface OptionOrderDetail {
  underlying: string;
  contract: string;
  /** The contract in plain words, e.g. "AAPL 105 call, expiring Fri Dec 26". */
  words: string;
  /** The contract list the pick was made from (§6.3); absent on an exit, which never re-resolves. */
  listVersion?: string | undefined;
  /** Decided while the market was closed and resolved again at release (§6.2): the first pick. */
  decided?: { contract: string; words: string; at: string; listVersion: string } | undefined;
  /** The quote the limit came from. */
  quote?: { bid: string; ask: string; at: string } | undefined;
  /** Why the app placed it, for a lifecycle close (e.g. closed before expiry). */
  lifecycle?: string | undefined;
  /**
   * Phase O2: the leg's combo, its net limit and dollars at pricing time
   * (§§7.2, 7.3, 8.1), and how a combo close went (one order, or legs with the
   * short ones first after the combo close was refused).
   */
  combo?:
    | {
        /** Every leg in words, e.g. "Sell 1 ZZZ 105 call". */
        legs: string[];
        /** Net per share of one set: positive a debit, negative a credit. */
        netLimit: string;
        sets: string;
        maxLoss?: string | undefined;
        buyingPower?: string | undefined;
        path?: 'combo' | 'legs_short_first' | undefined;
      }
    | undefined;
  /**
   * Phase O3: a call or put sold on its own, a covered call or a cash-secured
   * put, with what it can lose and the cash set aside, at pricing time.
   */
  sold?:
    | {
        kind: 'covered_call' | 'cash_secured_put';
        maxLoss: string;
        buyingPower: string;
      }
    | undefined;
  /** Phase O3: the roll this order belongs to (1 for the first), when a roll rule placed it. */
  roll?: number | undefined;
  /** Phase O2: where the delta rule's Greeks came from, when it picked the strike. */
  greeks?: { source: 'broker' | 'app'; delta: string } | undefined;
}

/**
 * The parts an idempotency key is derived from. A retry of the same leg in the
 * same cycle produces the same key, so the broker and the database both refuse
 * a second submission (§8.5). `attempt` changes only when the strategy itself
 * deliberately places the leg again.
 */
export interface IdempotencyParts {
  runtimeId: string;
  cycleId: string;
  phase: PhaseName | 'flatten';
  legId: string;
  attempt: number;
}

export function idempotencySeed(p: IdempotencyParts): string {
  return ['tm1', p.runtimeId, p.cycleId, p.phase, p.legId, String(p.attempt)].join('|');
}
