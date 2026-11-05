'use client';

import {
  exitFollowsEntry,
  ORDER_TYPES,
  QUANTITY_TYPES,
  randomId,
  refillExitOrders,
  syncExitWithEntry,
  TIME_IN_FORCE,
  type Expr,
  type OrderSide,
  type PhaseName,
  type PlannedOrder,
  type StrategyDefinition,
} from '@tm/domain';
import { useState } from 'react';
import {
  describeTiming,
  ORDER_TYPE_LABELS,
  QUANTITY_LABELS,
  SIDE_LABELS,
  TIF_LABELS,
} from '@/lib/strategy-text';
import { useEditor } from './editor-context';
import { ExpressionEditor, newExpr } from './expression-editor';
import { MiniInput, MiniSelect, RowButton } from './fields';
import { TimingEditor } from './timing-editor';

const PHASE_SIDES: Record<PhaseName, readonly OrderSide[]> = {
  entry: ['buy', 'sell_short'],
  exit: ['sell', 'buy_to_cover', 'close', 'reduce'],
};
const PHASE_TITLE: Record<PhaseName, string> = { entry: 'Entry', exit: 'Exit' };
const MAX_LEGS = 20;

function uniqueLabel(def: StrategyDefinition, phase: PhaseName): string {
  const taken = new Set(
    [...def.entry.orders, ...def.exit.orders].map((o) => o.legLabel.trim().toLowerCase()),
  );
  for (let n = def[phase].orders.length + 1; ; n++) {
    const label = `${PHASE_TITLE[phase]} leg ${n}`;
    if (!taken.has(label.toLowerCase())) return label;
  }
}

/**
 * Planned orders for one phase (Design v1.0 §6.6): any number of legs, each
 * with its own instrument, side, quantity, order type, account and timing.
 * Common fields are always visible; the rest sit behind "More options".
 */
export function OrdersEditor({
  definition,
  phase,
  onChange,
}: {
  definition: StrategyDefinition;
  phase: PhaseName;
  onChange: (def: StrategyDefinition) => void;
}) {
  const { instruments, accounts, editable, issueAt } = useEditor();
  const orders = definition[phase].orders;
  const title = PHASE_TITLE[phase];
  const allLegs = (['entry', 'exit'] as const).flatMap((p) =>
    definition[p].orders.map((o) => ({ id: o.id, label: o.legLabel, phase: p })),
  );
  const labelOf = (id: string) => allLegs.find((l) => l.id === id)?.label;

  const setOrders = (next: PlannedOrder[], legOrder?: string[]) => {
    const edited: StrategyDefinition = {
      ...definition,
      [phase]: { ...definition[phase], orders: next },
      ...(legOrder ? { execution: { ...definition.execution, legOrder } } : {}),
    };
    // Exit legs follow Entry until the user changes them (ADR 0028).
    onChange(phase === 'entry' ? syncExitWithEntry(definition, edited) : edited);
  };
  const following = phase === 'exit' && orders.length > 0 && exitFollowsEntry(definition);
  const canRefill =
    phase === 'exit' &&
    definition.entry.orders.length > 0 &&
    (orders.length === 0 || !exitFollowsEntry(definition));
  const refill = () => {
    if (
      orders.length > 0 &&
      !window.confirm('Replace your Exit orders with the opposite of your Entry orders?')
    ) {
      return;
    }
    onChange(refillExitOrders(definition));
  };
  const legOrder = definition.execution.legOrder;

  const addLeg = () => {
    const account = accounts.find((a) => a.isDefault) ?? accounts[0];
    const leg: PlannedOrder = {
      id: randomId(),
      legLabel: uniqueLabel(definition, phase),
      instrumentId: instruments[0]?.id ?? '',
      accountId: account?.id ?? '',
      side: phase === 'entry' ? 'buy' : 'close',
      quantity: { type: 'units', value: '1', rounding: 'down' },
      orderType: 'market',
      timeInForce: 'day',
      extendedHours: false,
      timing: { mode: 'immediate' },
      timingOnly: false,
    };
    setOrders([...orders, leg], legOrder ? [...legOrder, leg.id] : undefined);
  };
  const update = (i: number, order: PlannedOrder) =>
    setOrders(orders.map((o, j) => (j === i ? order : o)));
  const remove = (i: number) => {
    const removed = orders[i];
    setOrders(
      orders.filter((_, j) => j !== i),
      legOrder && removed ? legOrder.filter((id) => id !== removed.id) : undefined,
    );
  };
  const move = (i: number, delta: -1 | 1) => {
    const next = [...orders];
    const [o] = next.splice(i, 1);
    if (!o) return;
    next.splice(i + delta, 0, o);
    setOrders(next);
  };
  const duplicate = (i: number) => {
    const source = orders[i];
    if (!source) return;
    const copy: PlannedOrder = {
      ...structuredClone(source),
      id: randomId(),
      legLabel: `${source.legLabel} copy`.slice(0, 40),
    };
    const next = [...orders];
    next.splice(i + 1, 0, copy);
    setOrders(next, legOrder ? [...legOrder, copy.id] : undefined);
  };

  return (
    <div className="mt-5 border-t border-line pt-4">
      <h3 className="text-base font-semibold text-order">{title} orders</h3>
      <p className="mb-3 text-sm text-ink-muted">
        {phase === 'entry'
          ? 'Orders placed when Entry qualifies. Each leg can trade a different instrument.'
          : 'Orders that close what Entry opened. Exit orders never open a new position.'}
      </p>
      {following && (
        <p
          className="mb-3 rounded-md bg-surface-2 px-2.5 py-1.5 text-xs text-ink-muted"
          role="note"
        >
          Filled in from your Entry orders: the opposite side on the same instrument and quantity.
          They keep following Entry until you change one; after that they&rsquo;re yours.
        </p>
      )}
      {issueAt([phase, 'orders']) && (
        <p className="mb-2 text-xs font-medium text-danger">{issueAt([phase, 'orders'])}</p>
      )}
      {orders.length === 0 ? (
        <p className="text-sm text-ink-muted">No {title} orders yet.</p>
      ) : (
        <ol className="space-y-3">
          {orders.map((order, i) => (
            <li key={order.id}>
              <LegEditor
                order={order}
                phase={phase}
                number={i + 1}
                count={orders.length}
                legs={allLegs.filter((l) => l.id !== order.id)}
                describe={(o) => describeTiming(o, labelOf)}
                onChange={(o) => update(i, o)}
                onMove={(d) => move(i, d)}
                onDuplicate={() => duplicate(i)}
                onRemove={() => remove(i)}
              />
            </li>
          ))}
        </ol>
      )}
      {orders.length > 1 && (
        <p className="mt-2 text-xs text-ink-muted">
          These legs are sent as separate orders, not as one atomic order. One can fill while
          another doesn&rsquo;t; the execution policy below decides what happens then.
        </p>
      )}
      {editable && (
        <button
          type="button"
          className="mt-3 rounded-md border border-line bg-surface px-2.5 py-1 text-sm font-medium hover:bg-surface-2 disabled:opacity-50"
          disabled={orders.length >= MAX_LEGS}
          onClick={addLeg}
        >
          + Add {title} order
        </button>
      )}
      {editable && canRefill && (
        <button
          type="button"
          className="ml-2 mt-3 rounded-md border border-line bg-surface px-2.5 py-1 text-sm font-medium hover:bg-surface-2"
          onClick={refill}
        >
          Match Entry orders
        </button>
      )}
    </div>
  );
}

function LegEditor({
  order,
  phase,
  number,
  count,
  legs,
  describe,
  onChange,
  onMove,
  onDuplicate,
  onRemove,
}: {
  order: PlannedOrder;
  phase: PhaseName;
  number: number;
  count: number;
  legs: { id: string; label: string; phase: PhaseName }[];
  describe: (o: PlannedOrder) => string;
  onChange: (o: PlannedOrder) => void;
  onMove: (delta: -1 | 1) => void;
  onDuplicate: () => void;
  onRemove: () => void;
}) {
  const { instruments, accounts, editable, issueAt, baseCurrency } = useEditor();
  const [expanded, setExpanded] = useState(false);
  const path = [phase, 'orders', number - 1] as const;
  const err = (...rest: (string | number)[]) => issueAt([...path, ...rest]);
  const id = (f: string) => `${order.id}-${f}`;
  const name = `${PHASE_TITLE[phase]} leg ${number}`;
  const sides = PHASE_SIDES[phase].includes(order.side)
    ? PHASE_SIDES[phase]
    : [...PHASE_SIDES[phase], order.side];
  const needsLimit = order.orderType === 'limit' || order.orderType === 'stop_limit';
  const needsStop =
    order.orderType === 'stop' ||
    order.orderType === 'stop_limit' ||
    order.quantity.type === 'risk_sized';
  const set = (patch: Partial<PlannedOrder>) => onChange({ ...order, ...patch });
  const priceDefault = (): Expr =>
    ({ ...newExpr('market', order.instrumentId), field: 'last' }) as Expr;

  return (
    <section
      aria-label={name}
      className="rounded-md border border-l-4 border-line border-l-order bg-order-soft p-3"
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-semibold">
          {name}: {order.legLabel || 'Unnamed'}
        </span>
        {editable && (
          <div className="flex gap-1">
            <RowButton label={`Move ${name} up`} disabled={number === 1} onClick={() => onMove(-1)}>
              ↑ Up
            </RowButton>
            <RowButton
              label={`Move ${name} down`}
              disabled={number === count}
              onClick={() => onMove(1)}
            >
              ↓ Down
            </RowButton>
            <RowButton label={`Duplicate ${name}`} onClick={onDuplicate}>
              Duplicate
            </RowButton>
            <RowButton label={`Remove ${name}`} className="text-danger" onClick={onRemove}>
              Remove
            </RowButton>
          </div>
        )}
      </div>

      <fieldset disabled={!editable} className="min-w-0">
        <legend className="sr-only">{name} order details</legend>
        <div className="grid-fields-wide gap-2">
          <MiniInput
            id={id('label')}
            label="Leg name"
            value={order.legLabel}
            maxLength={40}
            error={err('legLabel')}
            onChange={(e) => set({ legLabel: e.target.value })}
          />
          <MiniSelect
            id={id('instrument')}
            label="Instrument"
            value={order.instrumentId}
            error={err('instrumentId')}
            onChange={(e) => set({ instrumentId: e.target.value })}
          >
            {!instruments.some((i) => i.id === order.instrumentId) && (
              <option value={order.instrumentId}>Choose an instrument</option>
            )}
            {instruments.map((i) => (
              <option key={i.id} value={i.id}>
                {i.symbol} · {i.assetClass.toUpperCase()}
              </option>
            ))}
          </MiniSelect>
          <MiniSelect
            id={id('side')}
            label="Side"
            value={order.side}
            error={err('side')}
            onChange={(e) => set({ side: e.target.value as OrderSide })}
          >
            {sides.map((s) => (
              <option key={s} value={s}>
                {SIDE_LABELS[s]}
              </option>
            ))}
          </MiniSelect>
          <MiniSelect
            id={id('qty-type')}
            label="Quantity in"
            value={order.quantity.type}
            onChange={(e) =>
              set({
                quantity: {
                  ...order.quantity,
                  type: e.target.value as PlannedOrder['quantity']['type'],
                },
              })
            }
          >
            {QUANTITY_TYPES.map((q) => (
              <option key={q} value={q}>
                {q === 'notional' || q === 'risk_sized'
                  ? QUANTITY_LABELS[q].replace('base currency', baseCurrency)
                  : QUANTITY_LABELS[q]}
              </option>
            ))}
          </MiniSelect>
          <MiniInput
            id={id('qty')}
            label="Quantity"
            inputMode="decimal"
            value={order.quantity.value}
            error={err('quantity', 'value')}
            onChange={(e) => set({ quantity: { ...order.quantity, value: e.target.value.trim() } })}
          />
          <MiniSelect
            id={id('type')}
            label="Order type"
            value={order.orderType}
            onChange={(e) => {
              const orderType = e.target.value as PlannedOrder['orderType'];
              const limit = orderType === 'limit' || orderType === 'stop_limit';
              const stop = orderType === 'stop' || orderType === 'stop_limit';
              const { limitPrice, stopPrice, ...rest } = order;
              onChange({
                ...rest,
                orderType,
                ...(limit ? { limitPrice: limitPrice ?? priceDefault() } : {}),
                ...(stop || order.quantity.type === 'risk_sized'
                  ? { stopPrice: stopPrice ?? priceDefault() }
                  : {}),
              });
              if (limit || stop) setExpanded(true);
            }}
          >
            {ORDER_TYPES.map((t) => (
              <option key={t} value={t}>
                {ORDER_TYPE_LABELS[t]}
              </option>
            ))}
          </MiniSelect>
          <MiniSelect
            id={id('account')}
            label="Account"
            value={order.accountId}
            error={err('accountId')}
            onChange={(e) => set({ accountId: e.target.value })}
          >
            {!accounts.some((a) => a.id === order.accountId) && (
              <option value={order.accountId}>Choose an account</option>
            )}
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.nickname} ({a.mode === 'paper' ? 'Paper' : 'Live'})
              </option>
            ))}
          </MiniSelect>
        </div>

        <div className="mt-2">
          <TimingEditor
            order={order}
            phase={phase}
            legs={legs}
            path={path}
            onChange={(patch) => set(patch)}
          />
        </div>

        <button
          type="button"
          className="mt-2 text-xs font-medium text-ink-muted underline"
          aria-expanded={expanded}
          aria-controls={id('more')}
          onClick={() => setExpanded((e) => !e)}
        >
          {expanded ? 'Fewer options' : 'More options'}
          <span className="sr-only"> for {name}</span>
        </button>
        <div id={id('more')} hidden={!expanded} className="mt-2 space-y-2">
          {needsLimit && order.limitPrice && (
            <ExpressionEditor
              expr={order.limitPrice}
              legend="Limit price"
              path={[...path, 'limitPrice']}
              onChange={(limitPrice) => set({ limitPrice })}
            />
          )}
          {needsStop && (
            <ExpressionEditor
              expr={order.stopPrice ?? priceDefault()}
              legend="Stop price"
              path={[...path, 'stopPrice']}
              onChange={(stopPrice) => set({ stopPrice })}
            />
          )}
          <div className="grid-fields-wide gap-2">
            <MiniSelect
              id={id('tif')}
              label="Time in force"
              value={order.timeInForce}
              onChange={(e) => set({ timeInForce: e.target.value as PlannedOrder['timeInForce'] })}
            >
              {TIME_IN_FORCE.map((t) => (
                <option key={t} value={t}>
                  {TIF_LABELS[t]}
                </option>
              ))}
            </MiniSelect>
            <MiniSelect
              id={id('rounding')}
              label="Round quantity"
              value={order.quantity.rounding}
              onChange={(e) =>
                set({
                  quantity: { ...order.quantity, rounding: e.target.value as 'down' | 'nearest' },
                })
              }
            >
              <option value="down">Down</option>
              <option value="nearest">To nearest</option>
            </MiniSelect>
            <label className="flex items-center gap-1.5 self-end pb-1 text-sm">
              <input
                type="checkbox"
                checked={order.extendedHours}
                onChange={(e) => set({ extendedHours: e.target.checked })}
              />
              Allow extended hours
            </label>
          </div>
          <MiniInput
            id={id('notes')}
            label="Notes"
            maxLength={500}
            value={order.notes ?? ''}
            onChange={(e) => {
              const { notes: _old, ...rest } = order;
              void _old;
              onChange(e.target.value ? { ...rest, notes: e.target.value } : rest);
            }}
          />
        </div>
      </fieldset>
      <p className="mt-2 text-xs text-ink-muted">
        <span className="font-semibold">Timing:</span> {describe(order)}
      </p>
    </section>
  );
}
