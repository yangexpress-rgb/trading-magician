'use client';

import type {
  RunDetailCycleDto,
  RunDetailDto,
  RunDetailKindDto,
  RuntimeSummaryDto,
} from '@tm/contracts';
import { Alert, Badge, Button, Dialog, Table, Td, Th, type Tone } from '@tm/ui';
import { useEffect, useState } from 'react';
import { apiClient } from '@/lib/api-client';
import { formatSignedMoney } from '@/lib/backtest-text';
import { formatPrice, ORDER_STATE, PHASE_LABELS } from '@/lib/order-text';
import { signTone } from '@/lib/sign-tone';
import { ORDER_TYPE_LABELS, SIDE_LABELS } from '@/lib/strategy-text';
import { strategyLabel } from './strategy-ref';

/** A figure on Strategies on paper that was double-clicked (N305). */
export interface RunDetailRequest {
  runtime: RuntimeSummaryDto;
  kind: RunDetailKindDto;
  /** The column the figure sits in, such as "Realized P/L". */
  column: string;
}

const KIND_TITLE: Record<RunDetailKindDto, string> = {
  working: 'Working orders',
  completed: 'Completed cycles',
  active: 'Active cycles',
  rejected: 'Rejected cycles',
  entering: 'Entering cycles',
  completed_today: 'Cycles completed today',
  today: "Today's return cycles",
};

const KIND_DESCRIPTION: Record<RunDetailKindDto, string> = {
  working: 'Orders of this run still working at the broker, with the cycle each belongs to.',
  completed:
    'Every order of the cycles Exit closed (they make up Completed, Realized P/L and Win rate).',
  active: 'Every order of the cycles whose Entry filled and whose position is open or exiting.',
  rejected:
    'Every order of the cycles that ended with nothing filled: refused by a risk limit, rejected, canceled or expired.',
  entering: 'Every order of the cycles whose Entry orders are still working.',
  completed_today: "Every cycle Exit closed in today's session, with all its orders and its P/L.",
  today:
    "Every order of the cycles behind today's return: those that completed today (realized) and those still holding a position (unrealized).",
};

const CYCLE_STATUS: Record<RunDetailCycleDto['status'], { label: string; tone: Tone }> = {
  closed: { label: 'Completed', tone: 'ok' },
  open: { label: 'Active, open', tone: 'info' },
  exit_working: { label: 'Active, exiting', tone: 'info' },
  aborted: { label: 'Rejected', tone: 'danger' },
  entry_working: { label: 'Entering', tone: 'warn' },
};

function label(map: Record<string, string>, key: string) {
  return map[key] ?? key;
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/**
 * The orders behind one figure of a run (N305), opened by double-clicking the
 * figure: each order of the cycles it counts (or each working order), with
 * its cycle's outcome beside it. An order name opens its full details.
 */
export function RunDetailDialog({
  request,
  when,
  onClose,
  onOpenOrder,
}: {
  request: RunDetailRequest | null;
  when: (iso: string | null) => string;
  onClose: () => void;
  onOpenOrder: (orderId: string) => void;
}) {
  const [detail, setDetail] = useState<RunDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runtimeId = request?.runtime.id;
  const kind = request?.kind;

  useEffect(() => {
    if (!runtimeId || !kind) return;
    let live = true;
    setDetail(null);
    setError(null);
    apiClient.execution.runDetail(runtimeId, kind).then(
      (d) => live && setDetail(d),
      () => live && setError('These orders could not be loaded. Try again in a moment.'),
    );
    return () => {
      live = false;
    };
  }, [runtimeId, kind]);

  const title = request ? `${strategyLabel(request.runtime)} · ${request.column}` : '';
  const description = kind ? KIND_DESCRIPTION[kind] : undefined;

  return (
    <Dialog
      open={request !== null}
      onClose={onClose}
      title={title}
      description={description}
      size="xl"
    >
      {error && <Alert>{error}</Alert>}
      {!detail && !error && <p className="text-sm">Loading orders…</p>}
      {detail && <DetailBody detail={detail} when={when} onOpenOrder={onOpenOrder} />}
      <div className="mt-4 flex justify-end">
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </div>
    </Dialog>
  );
}

function DetailBody({
  detail,
  when,
  onOpenOrder,
}: {
  detail: RunDetailDto;
  when: (iso: string | null) => string;
  onOpenOrder: (orderId: string) => void;
}) {
  const cycles = new Map(detail.cycles.map((c) => [c.id, c]));
  const withOrders = new Set(detail.orders.map((o) => o.cycleId));
  const bare = detail.cycles.filter((c) => !withOrders.has(c.id));
  const closed = detail.cycles.filter((c) => c.status === 'closed');
  const pnl = closed.reduce((sum, c) => sum + Number(c.realizedPnl ?? 0), 0);
  const wins = closed.filter((c) => Number(c.realizedPnl ?? 0) > 0).length;

  const summary = [
    detail.kind === 'working'
      ? `${plural(detail.orders.length, 'working order')} in ${plural(detail.totalCycles, 'cycle')}`
      : `${plural(detail.totalCycles, 'cycle')}, ${plural(detail.orders.length, 'order')}`,
  ];
  if ((detail.kind === 'completed' || detail.kind === 'completed_today') && closed.length > 0)
    summary.push(`${plural(wins, 'gain')}, ${plural(closed.length - wins, 'loss', 'losses')}`);

  return (
    <div className="space-y-3">
      <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
        <span>{summary.join(' · ')}</span>
        {(detail.kind === 'completed' ||
          detail.kind === 'completed_today' ||
          detail.kind === 'today') &&
          closed.length > 0 && (
            <span>
              Realized P/L{' '}
              <span className={signTone(pnl)}>
                <strong>{formatSignedMoney(pnl)}</strong>
              </span>
            </span>
          )}
      </p>
      {detail.totalCycles > detail.cycles.length && (
        <p className="text-sm text-ink-muted">
          Showing the newest {detail.cycles.length.toLocaleString('en-US')} of{' '}
          {detail.totalCycles.toLocaleString('en-US')} cycles.
        </p>
      )}
      {detail.cycles.length === 0 ? (
        <p className="text-sm text-ink-muted">Nothing to list: this figure is zero.</p>
      ) : (
        <Table label={`${KIND_TITLE[detail.kind]} orders`}>
          <thead>
            <tr>
              <Th numeric>Cycle</Th>
              <Th>Cycle result</Th>
              <Th numeric>Cycle P/L</Th>
              <Th>Phase</Th>
              <Th>Order</Th>
              <Th>Instrument</Th>
              <Th>Side</Th>
              <Th numeric>Filled / qty</Th>
              <Th>Type</Th>
              <Th>Status</Th>
              <Th>Submitted</Th>
              <Th>Filled</Th>
              <Th numeric>Avg price</Th>
            </tr>
          </thead>
          <tbody>
            {detail.orders.map((o) => {
              const c = cycles.get(o.cycleId);
              const s = ORDER_STATE[o.state];
              return (
                <tr key={o.id} className="hover:bg-surface-2">
                  {c ? <CycleCells cycle={c} when={when} /> : <td colSpan={3} />}
                  <Td>{PHASE_LABELS[o.phase]}</Td>
                  <Td>
                    <button
                      type="button"
                      className="text-left font-medium underline"
                      onClick={() => onOpenOrder(o.id)}
                    >
                      {o.legLabel}
                      <span className="sr-only"> details</span>
                    </button>
                  </Td>
                  <Td>{o.symbol}</Td>
                  <Td>{label(SIDE_LABELS, o.side)}</Td>
                  <Td numeric sortValue={Number(o.filledQuantity)}>
                    {o.filledQuantity} / {o.quantity}
                  </Td>
                  <Td>
                    {label(ORDER_TYPE_LABELS, o.orderType)}
                    {o.limitPrice ? ` ${formatPrice(o.limitPrice)}` : ''}
                  </Td>
                  <Td sortValue={s.label}>
                    <Badge tone={s.tone}>{s.label}</Badge>
                    {o.reason && (
                      <span className="mt-0.5 block max-w-[16rem] text-xs text-ink-muted">
                        {o.reason}
                      </span>
                    )}
                  </Td>
                  <Td className="whitespace-nowrap">
                    <When iso={o.submittedAt} when={when} />
                  </Td>
                  <Td className="whitespace-nowrap">
                    <When iso={o.filledAt} when={when} />
                  </Td>
                  <Td numeric>{formatPrice(o.averagePrice)}</Td>
                </tr>
              );
            })}
            {bare.map((c) => (
              <tr key={c.id}>
                <CycleCells cycle={c} when={when} />
                <Td>—</Td>
                <Td className="text-ink-muted">No orders</Td>
                <Td>{''}</Td>
                <Td>{''}</Td>
                <Td numeric>{''}</Td>
                <Td>{''}</Td>
                <Td>{''}</Td>
                <Td>{''}</Td>
                <Td>{''}</Td>
                <Td numeric>{''}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}

/** The cycle's number, outcome (with when it ended and any note) and P/L. */
function CycleCells({
  cycle: c,
  when,
}: {
  cycle: RunDetailCycleDto;
  when: (iso: string | null) => string;
}) {
  const s = CYCLE_STATUS[c.status];
  return (
    <>
      <Td numeric sortValue={c.seq} className="tabular-nums">
        {c.seq}
      </Td>
      <Td sortValue={s.label}>
        <Badge tone={s.tone}>{s.label}</Badge>
        <span className="mt-0.5 block text-xs whitespace-nowrap text-ink-muted">
          {c.closedAt ? `Ended ${when(c.closedAt)}` : `Entry fired ${when(c.entryTriggeredAt)}`}
        </span>
        {c.note && (
          <span className="mt-0.5 block max-w-[16rem] text-xs text-ink-muted">{c.note}</span>
        )}
      </Td>
      <Td numeric sortValue={c.realizedPnl === null ? '' : Number(c.realizedPnl)}>
        {c.realizedPnl === null ? (
          <span className="text-ink-muted">—</span>
        ) : (
          <span className={signTone(c.realizedPnl)}>{formatSignedMoney(c.realizedPnl)}</span>
        )}
      </Td>
    </>
  );
}

function When({ iso, when }: { iso: string | null; when: (iso: string | null) => string }) {
  return iso ? <time dateTime={iso}>{when(iso)}</time> : <span className="text-ink-muted">—</span>;
}
