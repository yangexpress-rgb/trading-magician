import type { OrderType, PlannedOrder } from '../strategy/schema';
import type { BrokerUpdate } from './order-state';
import type { Direction } from './sizing';

/**
 * The broker adapter contract (Design v1.0 §8.2–8.5, §9.3). Every broker,
 * simulated or real, sits behind it, and every adapter must pass the shared
 * contract suite in @tm/broker.
 */

export interface BrokerCapabilities {
  orderTypes: readonly OrderType[];
  timeInForce: readonly PlannedOrder['timeInForce'][];
  extendedHours: boolean;
  fractionalQuantities: boolean;
  shortSelling: boolean;
  /** Whether several legs can be filled all-or-none together. Never assumed (§6.7). */
  atomicMultiLeg: boolean;
  /**
   * Whether the adapter trades listed options (options brief v0.2 §5.5, ADR
   * 0123). Absent means no: the built-in simulator reports none, so options
   * legs are refused there with a plain reason.
   */
  options?: boolean | undefined;
}

export interface BrokerOrderRequest {
  /** The intent's idempotency key; a repeat returns the existing order (§8.5). */
  clientOrderId: string;
  accountId: string;
  instrumentId: string;
  symbol: string;
  direction: Direction;
  /** Short sale rather than a sale of shares held. */
  short: boolean;
  quantity: string;
  orderType: OrderType;
  limitPrice?: string | undefined;
  stopPrice?: string | undefined;
  timeInForce: PlannedOrder['timeInForce'];
  extendedHours: boolean;
  /** `option` for a contract order (ADR 0123); absent for stocks and ETFs. */
  assetClass?: 'option' | undefined;
}

/** The plain reason an adapter without options gives for an options order (A10). */
export const NO_OPTIONS_REASON = 'This broker doesn’t trade options';

export interface BrokerOrderUpdate extends BrokerUpdate {
  brokerOrderId: string;
  clientOrderId: string;
}

export interface BrokerPosition {
  instrumentId: string;
  /** Signed: negative is short. */
  quantity: string;
  averageCost: string | undefined;
}

/** Cash and equity as the broker reports them; the authority for performance (§10). */
export interface BrokerAccountBalance {
  currency: string;
  cash: string;
  equity: string;
  /** Day trades in the rolling five business days, where the broker says (ADR 0109). */
  dayTrades?: number | undefined;
  /** Whether it is a margin account, where the broker says. */
  margin?: boolean | undefined;
  /** The options level in force, 0–3, where the broker says (ADR 0123). */
  optionsLevel?: number | undefined;
}

export interface BrokerAdapter {
  readonly id: string;
  readonly capabilities: BrokerCapabilities;
  /**
   * Places an order. Resolves once the broker has it; acceptance, fills and
   * rejections arrive as updates. Submitting the same client order id again
   * returns the original order and places nothing new.
   */
  submitOrder(request: BrokerOrderRequest): Promise<{ brokerOrderId: string }>;
  /** Asks the broker to cancel. The outcome arrives as an update. */
  cancelOrder(accountId: string, brokerOrderId: string): Promise<void>;
  /**
   * Updates after `cursor` (opaque; omit for the start). Adapters for streaming
   * brokers buffer here; polling this is also the reconciliation path (§8.5).
   * Updates may repeat or arrive out of order.
   */
  updates(
    accountId: string,
    cursor: string | undefined,
  ): Promise<{ updates: BrokerOrderUpdate[]; cursor: string | undefined }>;
  /** Every update for one order, for reconciliation. */
  orderUpdates(accountId: string, brokerOrderId: string): Promise<BrokerOrderUpdate[]>;
  positions(accountId: string): Promise<BrokerPosition[]>;
  /**
   * Cash and equity, where the broker keeps them. The built-in simulator does
   * not; its accounts are valued from the app's own ledger (ADR 0020).
   */
  account?(accountId: string): Promise<BrokerAccountBalance | undefined>;
}

/** The broker refused the request outright; retrying will not help. */
export class BrokerRejectedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BrokerRejectedError';
  }
}

/** The broker could not be reached or timed out; the request may be retried. */
export class BrokerUnavailableError extends Error {
  constructor(message = 'The broker is not reachable') {
    super(message);
    this.name = 'BrokerUnavailableError';
  }
}
