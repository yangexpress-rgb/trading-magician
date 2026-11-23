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
