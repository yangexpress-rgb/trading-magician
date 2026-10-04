import Decimal from 'decimal.js';

/**
 * The canonical order model (Design v1.0 §8.4, §8.5).
 *
 * The app moves an order forward through the planning states itself, one step
 * at a time. Once an order is at the broker, its state is derived from the set
 * of broker updates received so far rather than from their arrival order, so
 * updates that arrive late, twice, or out of order always converge on the same
 * result.
 */

export const ORDER_STATES = [
  'planned',
  'scheduled',
  'pending_risk',
  'ready',
  'submitted',
  'acknowledged',
  'partially_filled',
  'filled',
  'canceled',
  'rejected',
  'expired',
  'failed',
] as const;
export type OrderState = (typeof ORDER_STATES)[number];

export const TERMINAL_ORDER_STATES = [
  'filled',
  'canceled',
  'rejected',
  'expired',
  'failed',
] as const;
export type TerminalOrderState = (typeof TERMINAL_ORDER_STATES)[number];
export const isTerminalOrderState = (s: OrderState): s is TerminalOrderState =>
  (TERMINAL_ORDER_STATES as readonly string[]).includes(s);

/** States in which an order may still fill at the broker. */
export const WORKING_ORDER_STATES = ['submitted', 'acknowledged', 'partially_filled'] as const;
export const isWorkingOrderState = (s: OrderState) =>
  (WORKING_ORDER_STATES as readonly string[]).includes(s);

/** Transitions the app makes itself, before and at submission. */
const APP_TRANSITIONS: Record<OrderState, readonly OrderState[]> = {
  planned: ['scheduled', 'pending_risk', 'canceled'],
  scheduled: ['pending_risk', 'canceled', 'expired'],
  pending_risk: ['ready', 'rejected', 'canceled'],
  ready: ['submitted', 'failed', 'canceled'],
  submitted: [],
  acknowledged: [],
  partially_filled: [],
  filled: [],
  canceled: [],
  rejected: [],
  expired: [],
  failed: [],
};

export function canTransitionOrder(from: OrderState, to: OrderState): boolean {
  return APP_TRANSITIONS[from].includes(to);
}

export class OrderTransitionError extends Error {
  constructor(
    readonly from: OrderState,
    readonly to: OrderState,
  ) {
    super(`An order cannot move from ${from} to ${to}`);
    this.name = 'OrderTransitionError';
  }
}

export function transitionOrder(from: OrderState, to: OrderState): OrderState {
  if (!canTransitionOrder(from, to)) throw new OrderTransitionError(from, to);
  return to;
}

// ---------------------------------------------------------------------------
// Broker updates
// ---------------------------------------------------------------------------

export const BROKER_UPDATE_KINDS = ['accepted', 'fill', 'canceled', 'rejected', 'expired'] as const;
export type BrokerUpdateKind = (typeof BROKER_UPDATE_KINDS)[number];

/** One normalized update from a broker adapter. */
export interface BrokerUpdate {
  /** Unique per order at the broker; repeats of the same id are ignored. */
  eventId: string;
  kind: BrokerUpdateKind;
  /** The broker's own status text, kept alongside the normalized kind (§8.4). */
  rawStatus: string;
  /** Provider timestamp, ISO 8601. */
  at: string;
  fill?: { quantity: string; price: string; fee: string } | undefined;
  reason?: string | undefined;
}

export interface BrokerOrderView {
  state: OrderState;
  filledQuantity: Decimal;
  /** Volume-weighted average fill price, or undefined before the first fill. */
  averagePrice: Decimal | undefined;
  fees: Decimal;
  /** Fills beyond the ordered quantity; reconciliation treats this as an incident. */
  overfilled: boolean;
  rawStatus: string | undefined;
  reason: string | undefined;
  acknowledgedAt: string | undefined;
  /** Time of the last fill, once the order is completely filled. */
  filledAt: string | undefined;
  /** Time the order reached a terminal state. */
  terminalAt: string | undefined;
}

/** Terminal outcomes other than filled, strongest first, for conflicting updates. */
const TERMINAL_PRECEDENCE: readonly BrokerUpdateKind[] = ['rejected', 'expired', 'canceled'];

const ZERO = new Decimal(0);
const latest = (a: string | undefined, b: string) => (a === undefined || b > a ? b : a);
const earliest = (a: string | undefined, b: string) => (a === undefined || b < a ? b : a);

/**
 * Derives an order's broker-side view from every update received for it. The
 * result depends only on the set of distinct updates, never on their order.
 */
export function deriveBrokerOrder(
  quantity: Decimal,
  updates: Iterable<BrokerUpdate>,
): BrokerOrderView {
  const seen = new Map<string, BrokerUpdate>();
  for (const u of updates) if (!seen.has(u.eventId)) seen.set(u.eventId, u);
  // Sort by id too, so ties on time still give one answer.
  const all = [...seen.values()].sort((a, b) =>
    a.at === b.at ? (a.eventId < b.eventId ? -1 : 1) : a.at < b.at ? -1 : 1,
  );

  let filled = ZERO;
  let cost = ZERO;
  let fees = ZERO;
  let acknowledgedAt: string | undefined;
  let lastFillAt: string | undefined;
  let terminal: BrokerUpdate | undefined;
  for (const u of all) {
    if (u.kind === 'fill' && u.fill) {
      const q = new Decimal(u.fill.quantity);
      filled = filled.plus(q);
      cost = cost.plus(q.times(u.fill.price));
      fees = fees.plus(u.fill.fee);
      lastFillAt = latest(lastFillAt, u.at);
    }
    if (u.kind !== 'rejected') acknowledgedAt = earliest(acknowledgedAt, u.at);
    if (TERMINAL_PRECEDENCE.includes(u.kind)) {
      const rank = TERMINAL_PRECEDENCE.indexOf(u.kind);
      if (!terminal || rank < TERMINAL_PRECEDENCE.indexOf(terminal.kind)) terminal = u;
    }
  }
  const last = all.at(-1);
  const averagePrice = filled.gt(0) ? cost.div(filled) : undefined;

  let state: OrderState;
  let terminalAt: string | undefined;
  if (filled.gte(quantity)) {
    state = 'filled';
    terminalAt = lastFillAt;
  } else if (terminal) {
    state = terminal.kind as 'rejected' | 'expired' | 'canceled';
    terminalAt = terminal.at;
  } else if (filled.gt(0)) state = 'partially_filled';
  else if (acknowledgedAt !== undefined) state = 'acknowledged';
  else state = 'submitted';

  return {
    state,
    filledQuantity: filled,
    averagePrice,
    fees,
    overfilled: filled.gt(quantity),
    rawStatus: last?.rawStatus,
    reason: terminal?.reason,
    acknowledgedAt,
    filledAt: state === 'filled' ? lastFillAt : undefined,
    terminalAt,
  };
}
