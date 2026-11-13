'use client';

import {
  CONTEXT_INSTRUMENT_ID,
  mirrorsEntry,
  cloneOrder,
  ORDER_TYPES,
  QUANTITY_TYPES,
  randomId,
  refillExitOrders,
  sizesFromAtr,
  syncExitWithEntry,
  TIME_IN_FORCE,
  type Expr,
  type OrderSide,
  type PhaseName,
  type PlannedOrder,
  type StrategyDefinition,
  type QuantityRounding,
} from '@tm/domain';
import { useState } from 'react';
import {
  describeTiming,
  ORDER_TYPE_LABELS,
  QUANTITY_LABELS,
  SIDE_LABELS,
  TIF_LABELS,
} from '@/lib/strategy-text';
import { defaultInstrumentOf, useEditor } from './editor-context';
import { ExpressionEditor, newExpr } from './expression-editor';
import { ConditionTreeEditor } from './condition-editor';
import { MiniInput, MiniSelect, RowButton } from './fields';
import { InstrumentSelect } from './instrument-select';
import { TimingEditor } from './timing-editor';
import { DEFAULT_RISK_DISTANCE } from '@/lib/slot-edits';

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

/** "<leg> copy", then "<leg> copy 2" …: a duplicated leg never repeats a name (N154). */
export function copyLabel(def: StrategyDefinition, label: string): string {
  const taken = new Set(
    [...def.entry.orders, ...def.exit.orders].map((o) => o.legLabel.trim().toLowerCase()),
  );
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? ' copy' : ` copy ${n}`;
    const candidate = `${label.slice(0, 40 - suffix.length)}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
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
  const editor = useEditor();
  const { accounts, editable, issueAt, baseCurrency } = editor;
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
    // A leg sized from the ATR reads the Entry's one risk distance (ADR 0049).
    if (phase === 'entry' && !edited.entry.risk && next.some((o) => sizesFromAtr(o)))
      edited.entry = { ...edited.entry, risk: { ...DEFAULT_RISK_DISTANCE } };
    // With "Mirror Entry legs" on, Exit is regenerated from Entry (ADR 0049).
    onChange(phase === 'entry' ? syncExitWithEntry(definition, edited) : edited);
  };
  const mirrored = phase === 'exit' && mirrorsEntry(definition.exit);
  const setMirror = (on: boolean) => {
    const exit = { ...definition.exit, mirrorEntry: on };
    onChange(on ? refillExitOrders({ ...definition, exit }) : { ...definition, exit });
  };
  // A group's first Entry leg is the order each pick gets (ADR 0073).
  const template = definition.trade.kind === 'group';
  const legOrder = definition.execution.legOrder;

  const addLeg = () => {
    const account = accounts.find((a) => a.isDefault) ?? accounts[0];
    const leg: PlannedOrder = {
      id: randomId(),
      legLabel: uniqueLabel(definition, phase),
      // A new leg starts on the stock or ETF in What to trade (N272).
      instrumentId: defaultInstrumentOf(editor),
      accountId: account?.id ?? '',
      side: phase === 'entry' ? 'buy' : 'close',
      quantity: { type: 'units', value: '1', rounding: 'up' },
      orderType: 'market',
      timeInForce: 'day',
      timing: { mode: 'immediate' },
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
    // Fresh ids for the leg and everything inside it, such as its leg condition (N154).
    const copy: PlannedOrder = {
      ...cloneOrder(source),
      legLabel: copyLabel(definition, source.legLabel),
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
          : 'Market or close orders that undo what Entry opened. Exit orders never open a new position.'}
      </p>
      {phase === 'exit' && (
        <div className="mb-3 rounded-md bg-surface-2 px-2.5 py-1.5">
          <label className="flex items-center gap-1.5 text-sm font-medium">
            <input
              type="checkbox"
              disabled={!editable}
              checked={mirrored}
              aria-describedby="exit-mirror-help"
              onChange={(e) => setMirror(e.target.checked)}
            />
            Mirror Entry legs
          </label>
          <p id="exit-mirror-help" className="text-xs text-ink-muted">
            {mirrored
              ? 'On: each Entry leg has an Exit leg with the opposite side, same instrument and quantity, at market. They change with Entry. Turn this off to build Exit legs yourself.'
              : 'Off: these Exit legs are yours, and editing Entry leaves them alone. Turn it on to replace them with the opposite of the Entry legs.'}
          </p>
        </div>
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
                selection={template}
                locked={mirrored}
                perInstrument={
                  template ? perInstrumentText(definition, order, baseCurrency) : undefined
                }
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
      {editable && !mirrored && (
        <button
          type="button"
          className="mt-3 rounded-md border border-line bg-surface px-2.5 py-1 text-sm font-medium hover:bg-surface-2 disabled:opacity-50"
          disabled={orders.length >= MAX_LEGS}
          onClick={addLeg}
        >
          + Add {title} order
        </button>
      )}
    </div>
  );
}

/** A group's template leg: what each pick gets (ADR 0073). */
function perInstrumentText(
  def: StrategyDefinition,
  order: PlannedOrder,
  currency: string,
): string | undefined {
  const trade = def.trade;
  if (trade.kind !== 'group' || def.entry.orders[0]?.id !== order.id) return undefined;
  const v = Number(order.quantity.value);
  if (!Number.isFinite(v) || order.quantity.type === 'risk') return undefined;
  const unit =
    order.quantity.type === 'units'
      ? ' shares'
      : order.quantity.type === 'pct_equity'
        ? '% of equity'
        : ` ${currency}`;
  const count = trade.ranking?.count;
  if (!trade.splitTotal || !count) return `${v.toLocaleString('en-US')}${unit} for each pick`;
  if (count.type === 'percent') return `Split equally across the top ${count.value}% of the group`;
  const n = Math.max(1, count.value);
  const each = v / n;
  const shown = order.quantity.type === 'units' ? Math.floor(each) : Number(each.toFixed(2));
  return `${shown.toLocaleString('en-US')}${unit} for each of the ${n} picks`;
}

function LegEditor({
  order,
  phase,
  number,
  count,
  legs,
  selection,
  locked,
  perInstrument,
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
  /** A Selection group's template leg: its quantity is the total, split equally. */
  selection: boolean;
  /** Generated from Entry ("Mirror Entry legs" on): shown, not edited. */
  locked: boolean;
  perInstrument?: string | undefined;
  describe: (o: PlannedOrder) => string;
  onChange: (o: PlannedOrder) => void;
  onMove: (delta: -1 | 1) => void;
  onDuplicate: () => void;
  onRemove: () => void;
}) {
  const { accounts, editable: canEdit, issueAt, baseCurrency } = useEditor();
  const editable = canEdit && !locked;
  const [expanded, setExpanded] = useState(false);
  const path = [phase, 'orders', number - 1] as const;
  const err = (...rest: (string | number)[]) => issueAt([...path, ...rest]);
  const id = (f: string) => `${order.id}-${f}`;
  const name = `${PHASE_TITLE[phase]} leg ${number}`;
  const sides = PHASE_SIDES[phase].includes(order.side)
    ? PHASE_SIDES[phase]
    : [...PHASE_SIDES[phase], order.side];
  const needsLimit = order.orderType === 'limit' || order.orderType === 'stop_limit';
  const fromStop = order.quantity.type === 'risk' && order.quantity.distanceFrom === 'stop_price';
  const needsStop = order.orderType === 'stop' || order.orderType === 'stop_limit' || fromStop;
  // Exit legs are market, limit or close orders (ADR 0049): a stop is the ATR
  // stop's job. A stop order saved before is kept, and shown as such.
  const orderTypes =
    phase === 'exit'
      ? ORDER_TYPES.filter((t) => (t !== 'stop' && t !== 'stop_limit') || t === order.orderType)
      : ORDER_TYPES;
  const riskTypes =
    phase === 'exit' && order.quantity.type !== 'risk'
      ? QUANTITY_TYPES.filter((q) => q !== 'risk')
      : QUANTITY_TYPES;
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
          <InstrumentSelect
            id={id('instrument')}
            value={order.instrumentId}
            error={err('instrumentId')}
            allowContext={selection || order.instrumentId === CONTEXT_INSTRUMENT_ID}
            tradableOnly
            format={(i) => `${i.symbol} · ${i.assetClass.toUpperCase()}`}
            onChange={(instrumentId) => set({ instrumentId })}
          />
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
            onChange={(e) => {
              const type = e.target.value as PlannedOrder['quantity']['type'];
              const { amountIn: _a, distanceFrom: _d, ...q } = order.quantity;
              void _a;
              void _d;
              // Risk 1% of equity over the Entry's ATR distance (v1.2 item 9, ADR 0049).
              set({
                quantity:
                  type === 'risk'
                    ? {
                        ...q,
                        type,
                        value: order.quantity.type === 'risk' ? q.value : '1',
                        amountIn: order.quantity.amountIn ?? 'pct_equity',
                        distanceFrom: order.quantity.distanceFrom ?? 'atr',
                      }
                    : { ...q, type },
              });
            }}
          >
            {riskTypes.map((q) => (
              <option key={q} value={q}>
                {q === 'notional'
                  ? QUANTITY_LABELS[q].replace('base currency', baseCurrency)
                  : QUANTITY_LABELS[q]}
              </option>
            ))}
          </MiniSelect>
          {order.quantity.type === 'risk' && (
            <>
              <MiniSelect
                id={id('qty-amount-in')}
                label="Risk"
                value={order.quantity.amountIn ?? ''}
                error={err('quantity')}
                onChange={(e) =>
                  set({
                    quantity: {
                      ...order.quantity,
                      amountIn: e.target.value as 'dollars' | 'pct_equity',
                    },
                  })
                }
              >
                {!order.quantity.amountIn && <option value="">Choose</option>}
                <option value="pct_equity">% of equity</option>
                <option value="dollars">An amount ({baseCurrency})</option>
              </MiniSelect>
              <MiniSelect
                id={id('qty-distance')}
                label="Down to"
                value={order.quantity.distanceFrom ?? ''}
                onChange={(e) => {
                  const distanceFrom = e.target.value as 'stop_price' | 'atr';
                  onChange({
                    ...order,
                    quantity: { ...order.quantity, distanceFrom },
                    ...(distanceFrom === 'stop_price' && !order.stopPrice
                      ? { stopPrice: priceDefault() }
                      : {}),
                  });
                  if (distanceFrom === 'stop_price') setExpanded(true);
                }}
              >
                {!order.quantity.distanceFrom && <option value="">Choose</option>}
                <option value="atr">The Entry&rsquo;s risk distance (ATR)</option>
                <option value="stop_price">This leg&rsquo;s stop price</option>
              </MiniSelect>
            </>
          )}
          <MiniInput
            id={id('qty')}
            label={
              order.quantity.type === 'risk'
                ? order.quantity.amountIn === 'dollars'
                  ? `Risk amount (${baseCurrency})`
                  : 'Risk (% of equity)'
                : selection
                  ? 'Total amount (split equally)'
                  : 'Quantity'
            }
            inputMode="decimal"
            value={order.quantity.value}
            error={err('quantity', 'value')}
            aria-describedby={perInstrument ? id('per-instrument') : undefined}
            onChange={(e) => set({ quantity: { ...order.quantity, value: e.target.value.trim() } })}
          />
          {perInstrument && (
            <p id={id('per-instrument')} className="self-end pb-1 text-xs text-ink-muted">
              {perInstrument}
            </p>
          )}
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
                ...(stop || fromStop ? { stopPrice: stopPrice ?? priceDefault() } : {}),
              });
              if (limit || stop) setExpanded(true);
            }}
          >
            {orderTypes.map((t) => (
              <option key={t} value={t}>
                {ORDER_TYPE_LABELS[t]}
                {phase === 'exit' && (t === 'stop' || t === 'stop_limit')
                  ? ' (kept from before; use the ATR stop)'
                  : ''}
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

        {/* Per-leg conditions left the builder (ADR 0073, O148); saved ones stay editable. */}
        {phase === 'entry' && !selection && order.legCondition && (
          <div className="mt-2">
            <h4 className="mb-1 text-sm font-semibold text-cond">Conditions for this leg only</h4>
            <p className="mb-1 text-xs text-ink-muted">
              Kept as saved: this leg enters when these hold and Enter when holds. &ldquo;This
              leg&rsquo;s instrument&rdquo; means {order.legLabel || 'this leg'}&rsquo;s instrument.
            </p>
            <ConditionTreeEditor
              root={order.legCondition}
              label={`${name} conditions`}
              path={[...path, 'legCondition']}
              onChange={(legCondition) => set({ legCondition })}
            />
            {editable && (
              <RowButton
                label={`Remove the conditions for ${name}`}
                className="mt-1 text-danger"
                onClick={() => {
                  const { legCondition: _l, ...rest } = order;
                  void _l;
                  onChange(rest);
                }}
              >
                Remove leg conditions
              </RowButton>
            )}
          </div>
        )}

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
                  quantity: { ...order.quantity, rounding: e.target.value as QuantityRounding },
                })
              }
            >
              <option value="up">Up, at least 1 unit</option>
              <option value="down">Down</option>
              <option value="nearest">To nearest</option>
            </MiniSelect>
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
