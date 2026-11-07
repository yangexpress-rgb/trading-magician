import { randomId, type IdFactory } from './ids';
import type { OrderSide, PlannedOrder, StrategyDefinition } from './schema';

/**
 * Exit orders pre-filled from Entry (ADR 0028).
 *
 * Each Entry leg gets an Exit leg that undoes it: Buy becomes Sell and Sell
 * short becomes Buy to cover, on the same instrument and account. A leg sized
 * in shares exits the same number of shares. A leg sized any other way (cash
 * amount, % of equity, risk) can't be mirrored share for share, so its Exit
 * closes whatever that instrument holds; one Close per instrument and account
 * is enough. Exits go out at market, good for the day, as soon as Exit
 * qualifies. Nothing here is locked: the user edits the result like any leg.
 */
const OPPOSITE: Partial<Record<OrderSide, OrderSide>> = {
  buy: 'sell',
  sell_short: 'buy_to_cover',
};

function exitLabel(entryLabel: string): string {
  const trimmed = entryLabel.trim();
  const label = /^entry\b/i.test(trimmed)
    ? `Exit${trimmed.slice(5)}`
    : `Exit ${trimmed || 'leg'}`.trim();
  return label.slice(0, 40);
}

type Mirrored = Omit<PlannedOrder, 'id'>;

function mirrorContent(entry: readonly PlannedOrder[]): Mirrored[] {
  const out: Mirrored[] = [];
  const closed = new Set<string>();
  for (const e of entry) {
    const byUnits = e.quantity.type === 'units';
    const opposite = OPPOSITE[e.side];
    const side: OrderSide = byUnits && opposite ? opposite : 'close';
    if (side === 'close') {
      const key = `${e.instrumentId}|${e.accountId}`;
      if (closed.has(key)) continue;
      closed.add(key);
    }
    out.push({
      legLabel: exitLabel(e.legLabel),
      instrumentId: e.instrumentId,
      accountId: e.accountId,
      side,
      quantity: { ...e.quantity },
      orderType: 'market',
      timeInForce: 'day',
      timing: { mode: 'immediate' },
    });
  }
  // Labels must be unique across both phases.
  const taken = new Set(entry.map((e) => e.legLabel.trim().toLowerCase()));
  for (const o of out) {
    let label = o.legLabel;
    for (let n = 2; taken.has(label.toLowerCase()); n++) {
      const suffix = ` ${n}`;
      label = o.legLabel.slice(0, 40 - suffix.length) + suffix;
    }
    taken.add(label.toLowerCase());
    o.legLabel = label;
  }
  return out;
}

/** Exit legs that undo the given Entry legs. */
export function mirrorEntryOrders(
  entry: readonly PlannedOrder[],
  ids: IdFactory = randomId,
): PlannedOrder[] {
  return mirrorContent(entry).map((o) => ({ id: ids(), ...o }));
}

/**
 * Whether the Exit legs are generated from Entry: the visible "Mirror Entry
 * legs" switch on the Exit card (ADR 0049). On, every Entry edit regenerates
 * them; off, they are hand-built and Entry edits leave them alone.
 */
export const mirrorsEntry = (exit: { mirrorEntry?: boolean | undefined }) =>
  exit.mirrorEntry === true;

/**
 * Re-fill Exit legs from Entry, reusing the existing Exit leg ids in order so
 * that references to them survive, and keeping a sequential submission order
 * (`execution.legOrder`) in step with the legs that were added or dropped.
 */
export function refillExitOrders(
  def: StrategyDefinition,
  ids: IdFactory = randomId,
): StrategyDefinition {
  const existing = def.exit.orders.map((o) => o.id);
  const orders = mirrorContent(def.entry.orders).map((o, i) => ({
    id: existing[i] ?? ids(),
    ...o,
  }));
  const kept = new Set(orders.map((o) => o.id));
  const dropped = new Set(existing.filter((id) => !kept.has(id)));
  const added = orders.map((o) => o.id).filter((id) => !existing.includes(id));
  const legOrder = def.execution.legOrder;
  return {
    ...def,
    exit: { ...def.exit, orders },
    ...(legOrder
      ? {
          execution: {
            ...def.execution,
            legOrder: [...legOrder.filter((id) => !dropped.has(id)), ...added],
          },
        }
      : {}),
  };
}

/**
 * Apply an edit that changed Entry orders: with "Mirror Entry legs" on, Exit
 * is regenerated from the new Entry; off, Exit is left alone.
 */
export function syncExitWithEntry(
  before: StrategyDefinition,
  after: StrategyDefinition,
  ids: IdFactory = randomId,
): StrategyDefinition {
  if (before.entry.orders === after.entry.orders) return after;
  if (!mirrorsEntry(after.exit)) return after;
  return refillExitOrders(after, ids);
}
