import type { OptionQuote } from '../options/quotes';
import type { ContractListEntry } from '../options/resolver';
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
  /**
   * Whether the adapter places options combos as one multi-leg order (Phase
   * O2, `submitMultiLeg`). Kept apart from `atomicMultiLeg`, which keeps its
   * meaning for stock and ETF legs (ADR 0123).
   */
  optionCombos?: boolean | undefined;
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
  /** Options only (§5.1): what the order does to the position, sent as the broker's intent. */
  positionIntent?: PositionIntent | undefined;
}

/**
 * An options combo (options brief v0.2 §§5.5, 7.2; ADR 0123 Phase O2): legs
 * filled all-or-none as one broker order at one net limit price. Only on
 * adapters whose `capabilities.atomicMultiLeg` is true.
 */
export interface MultiLegOrderRequest {
  /** The combo's own idempotency key; a repeat returns the existing order. */
  clientOrderId: string;
  accountId: string;
  legs: readonly {
    /** The leg intent's key: `comboLegClientOrderId(clientOrderId, symbol)`. */
    clientOrderId: string;
    instrumentId: string;
    symbol: string;
    /** Contracts per set, in lowest terms. */
    ratio: number;
    direction: Direction;
    positionIntent: PositionIntent;
  }[];
  /** Sets. */
  quantity: string;
  /** Net price per share of one set: positive is a debit paid, negative a credit received. */
  limitPrice: string;
  timeInForce: 'day' | 'gtc';
}

/**
 * The client order id a combo leg's updates carry: the combo's own with the
 * leg's contract, so updates of one broker order map back to each leg intent.
 */
export const comboLegClientOrderId = (comboClientOrderId: string, symbol: string) =>
  `${comboClientOrderId}.${symbol}`;

/** One options lifecycle event in the broker's activity record (Phase O2). */
export interface OptionActivity {
  kind: 'assignment' | 'exercise' | 'expiry';
  /** OCC symbol. */
  symbol: string;
  quantity: string;
  /** YYYY-MM-DD. */
  date: string;
}

export type PositionIntent = 'buy_to_open' | 'sell_to_open' | 'buy_to_close' | 'sell_to_close';

/** §5.1: a leg's side as the broker's position intent. */
export function positionIntentFor(side: PlannedOrder['side']): PositionIntent {
  switch (side) {
    case 'buy':
      return 'buy_to_open';
    case 'sell_short':
      return 'sell_to_open';
    case 'buy_to_cover':
      return 'buy_to_close';
    default:
      return 'sell_to_close';
  }
}

/** §6.3: which contracts to read for an underlying. */
export interface ContractListQuery {
  underlying: string;
  expirationGte: string;
  expirationLte: string;
  strikeGte: string;
  strikeLte: string;
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
  /**
   * Options only (options brief v0.2 §§6.3, 8.2; ADR 0123), on adapters whose
   * `capabilities.options` is true: the latest quotes of some contracts, keyed
   * by OCC symbol, and the listed contracts of an underlying. Both draw on the
   * options share of the broker's request budget and never wait for it.
   */
  optionQuotes?(accountId: string, symbols: readonly string[]): Promise<Map<string, OptionQuote>>;
  optionContracts?(accountId: string, query: ContractListQuery): Promise<ContractListEntry[]>;
  /**
   * Phase O2, the delta rule: each contract's delta as the broker reports it,
   * by OCC symbol; contracts without Greeks are left out.
   */
  optionDeltas?(accountId: string, symbols: readonly string[]): Promise<Map<string, number>>;
  /**
   * Phase O2: the broker's own record of assignments, exercises and expiries
   * posted on or after `after` (YYYY-MM-DD), to confirm what the app inferred.
   */
  optionActivities?(accountId: string, after: string): Promise<OptionActivity[]>;
  /**
   * Phase O2 (§7.5): an underlying's announced cash dividends with ex-dates
   * from `from` to `to` (YYYY-MM-DD), for the dividend watch.
   */
  cashDividends?(
    accountId: string,
    symbol: string,
    from: string,
    to: string,
  ): Promise<{ exDate: string; cashAmount: string }[]>;
  /**
   * Options re-price (§7.1): a working limit order's price changed in place.
   * The broker gives the order a new id, reported under `clientOrderId`, which
   * the app maps back to the same intent (`repriceClientOrderId`).
   */
  replaceOrder?(
    accountId: string,
    brokerOrderId: string,
    change: { limitPrice: string; clientOrderId: string },
  ): Promise<{ brokerOrderId: string }>;
  /**
   * Phase O2: places a combo as one order (§7.2). Each leg's updates carry its
   * own `clientOrderId` and the combo's broker order id; the broker refusing
   * the combo places no leg at all.
   */
  submitMultiLeg?(request: MultiLegOrderRequest): Promise<{ brokerOrderId: string }>;
}

/** The client order id of a re-priced order (ADR 0123): the intent's own, marked. */
export const repriceClientOrderId = (clientOrderId: string) => `${clientOrderId}_r`;

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
