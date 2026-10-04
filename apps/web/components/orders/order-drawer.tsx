'use client';

import { ApiError, type OrderDetailDto } from '@tm/contracts';
import { formatDateTime, type DisplayPreferences } from '@tm/domain';
import { Alert, Badge, Button, Drawer, ModeBadge } from '@tm/ui';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { apiClient } from '@/lib/api-client';
import {
  describeEvent,
  EVENT_SOURCE_LABELS,
  formatPrice,
  ORDER_STATE,
  PHASE_LABELS,
  riskLabel,
  SOURCE_LABELS,
} from '@/lib/order-text';
import {
  describeCondition,
  describeLeg,
  ORDER_TYPE_LABELS,
  SIDE_LABELS,
  TIF_LABELS,
  TRIGGER_LABELS,
} from '@/lib/strategy-text';

const WORKING = new Set(['ready', 'submitted', 'acknowledged', 'partially_filled']);

function label<T extends Record<string, string>>(map: T, key: string): string {
  return (map as Record<string, string>)[key] ?? key;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-5" aria-label={title}>
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="mt-2 text-sm">{children}</div>
    </section>
  );
}

function Pairs({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
      {rows.map(([term, value]) => (
        <div key={term} className="contents">
          <dt className="text-ink-muted">{term}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * One order's full story (§8.3): what was asked for, the rule and trigger it
 * came from, the risk check, every broker event and fill. A working order can
 * be canceled here, after a confirmation, as the person's own action (§14.3).
 */
export function OrderDrawer({
  orderId,
  version,
  prefs,
  symbols,
  onClose,
  onChanged,
}: {
  orderId: string | null;
  /** Changes whenever the list refreshes, so the open order re-reads too. */
  version: number;
  prefs: DisplayPreferences;
  symbols: Map<string, string>;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<OrderDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!orderId) {
      setDetail(null);
      setConfirming(false);
      return;
    }
    let cancelled = false;
    apiClient.orders.get(orderId).then(
      (d) => {
        if (!cancelled) {
          setDetail(d);
          setError(null);
        }
      },
      (e: unknown) => {
        if (!cancelled) setError(e instanceof ApiError ? e.message : 'Could not load this order.');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [orderId, version]);

  const when = (iso: string | null) =>
    iso
      ? formatDateTime(iso, prefs, {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          second: '2-digit',
        })
      : '—';
  const symbol = (id: string) => symbols.get(id);

  async function cancel() {
    if (!detail) return;
    setBusy(true);
    try {
      setDetail(await apiClient.orders.cancel(detail.id));
      setConfirming(false);
      setError(null);
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not cancel this order.');
    } finally {
      setBusy(false);
    }
  }

  const d = detail?.id === orderId ? detail : null;
  const state = d ? ORDER_STATE[d.state] : null;
  const canCancel = d && WORKING.has(d.state) && !d.cancelRequested;
  const rule = d?.sourceRule;

  return (
    <Drawer
      open={orderId !== null}
      onClose={onClose}
      title={d ? `${d.legLabel} · ${d.symbol}` : 'Order'}
      description={
        d && state ? (
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={state.tone}>{state.label}</Badge>
            <ModeBadge mode={d.mode} />
            <span>
              {PHASE_LABELS[d.phase]} · cycle {d.cycleSeq} · placed by{' '}
              {SOURCE_LABELS[d.source].toLowerCase()}
            </span>
          </span>
        ) : undefined
      }
    >
      {error && <Alert>{error}</Alert>}
      {!d && !error && <p className="text-sm">Loading the order…</p>}
      {d && (
        <>
          {d.cancelRequested && WORKING.has(d.state) && (
            <Alert tone="info">Cancel requested. Waiting for the broker to confirm.</Alert>
          )}
          {canCancel && !confirming && (
            <Button variant="danger" size="sm" onClick={() => setConfirming(true)}>
              Cancel order
            </Button>
          )}
          {canCancel && confirming && (
            <div
              role="group"
              aria-label="Confirm cancel"
              className="rounded-md border border-danger/40 bg-danger-soft p-3"
            >
              <p className="text-sm font-medium">
                Cancel this order? The strategy keeps running; this cancel is recorded as yours.
              </p>
              <div className="mt-2 flex gap-2">
                <Button variant="danger" size="sm" onClick={() => void cancel()} disabled={busy}>
                  {busy ? 'Canceling…' : 'Yes, cancel order'}
                </Button>
                <Button size="sm" onClick={() => setConfirming(false)} disabled={busy}>
                  Keep order
                </Button>
              </div>
            </div>
          )}

          <Section title="Order">
            <Pairs
              rows={[
                [
                  'Strategy',
                  <Link
                    key="s"
                    className="underline"
                    href={
                      d.versionNo
                        ? `/strategy-lab/${d.strategyId}/versions/${d.versionNo}`
                        : `/strategy-lab/${d.strategyId}`
                    }
                  >
                    {d.strategyName}
                    {d.versionNo ? ` (version ${d.versionNo})` : ''}
                  </Link>,
                ],
                ['Account', d.accountName],
                ['Side', label(SIDE_LABELS, d.side)],
                ['Quantity', `${d.filledQuantity} of ${d.quantity} filled`],
                [
                  'Type',
                  `${label(ORDER_TYPE_LABELS, d.orderType)}${d.limitPrice ? `, limit ${formatPrice(d.limitPrice)}` : ''}${d.stopPrice ? `, stop ${formatPrice(d.stopPrice)}` : ''} · ${label(TIF_LABELS, d.timeInForce)}`,
                ],
                ['Average fill price', formatPrice(d.averagePrice)],
                ['Reference price', formatPrice(d.referencePrice)],
                ['Eligible', when(d.eligibleAt)],
                ['Submitted', when(d.submittedAt)],
                ['Filled', when(d.filledAt)],
                ...(d.reason ? ([['Reason', d.reason]] as [string, string][]) : []),
                ['Broker order', d.brokerOrderId ?? 'Not sent yet'],
                ['Idempotency key', <code key="k">{d.idempotencyKey}</code>],
              ]}
            />
          </Section>

          <Section title="Source rule">
            {d.source !== 'strategy' ? (
              <p>
                {d.source === 'user'
                  ? 'Placed by you to close a position after the strategy stopped.'
                  : 'Placed automatically to close what a failed multi-leg order left open.'}
              </p>
            ) : (
              <Pairs
                rows={[
                  [
                    'Leg',
                    rule?.plannedOrder ? describeLeg(rule.plannedOrder, symbol, 'USD') : d.legLabel,
                  ],
                  [
                    `${PHASE_LABELS[d.phase]} conditions`,
                    rule?.condition ? describeCondition(rule.condition, symbol) : '—',
                  ],
                  ['Trigger', rule?.trigger ? TRIGGER_LABELS[rule.trigger.mode] : '—'],
                ]}
              />
            )}
          </Section>

          {d.triggerEvent && (
            <Section title="Trigger event">
              <Pairs
                rows={[
                  ['Evaluated', when(d.triggerEvent.evaluatedAt)],
                  ['Data as of', when(d.triggerEvent.dataTime)],
                  ['Result', d.triggerEvent.result === 'true' ? 'True' : d.triggerEvent.result],
                  ...Object.entries(d.triggerEvent.values ?? {})
                    .slice(0, 12)
                    .map(([k, v]) => [`Value ${k}`, String(v)] as [string, string]),
                ]}
              />
            </Section>
          )}

          <Section title="Risk check">
            <ul className="space-y-1">
              {d.risk.checks.map((c) => (
                <li key={c.code}>
                  <span className="font-medium">{c.passed ? 'Passed' : 'Failed'}</span>{' '}
                  {riskLabel(c.code)}
                  {c.value !== undefined && c.limit !== undefined
                    ? ` (${c.value} against a limit of ${c.limit})`
                    : ''}
                </li>
              ))}
              {d.risk.checks.length === 0 && <li>No checks applied</li>}
            </ul>
          </Section>

          {d.fills.length > 0 && (
            <Section title="Fills">
              <ul className="space-y-1">
                {d.fills.map((f) => (
                  <li key={f.id}>
                    {f.quantity} at {formatPrice(f.price)} · {when(f.filledAt)}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <Section title="Timeline">
            <ol className="space-y-2 border-l border-line pl-3">
              {d.timeline.map((e) => (
                <li key={e.seq}>
                  <p className="font-medium">{describeEvent(e)}</p>
                  <p className="text-xs text-ink-muted">
                    {when(e.providerAt ?? e.receivedAt)} ·{' '}
                    {EVENT_SOURCE_LABELS[e.source] ?? e.source}
                    {e.toState ? ` · ${ORDER_STATE[e.toState].label}` : ''}
                  </p>
                </li>
              ))}
            </ol>
          </Section>
        </>
      )}
    </Drawer>
  );
}
