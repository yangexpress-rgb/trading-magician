'use client';

import {
  ApiError,
  ORDER_VIEWS,
  type ExecutionStatusDto,
  type OrderRowDto,
  type PositionDto,
  type ScheduledRowDto,
} from '@tm/contracts';
import { formatDateTime, type DisplayPreferences } from '@tm/domain';
import {
  Alert,
  Badge,
  Button,
  cx,
  Dialog,
  EmptyState,
  ModeBadge,
  OrdersIcon,
  PageHeader,
  SelectField,
  Table,
  Td,
  TextField,
  Th,
} from '@tm/ui';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { apiClient } from '@/lib/api-client';
import {
  describeHolding,
  formatPrice,
  ORDER_STATE,
  PHASE_LABELS,
  RUNTIME_STATUS,
  SOURCE_LABELS,
  VIEW_LABELS,
} from '@/lib/order-text';
import { ORDER_TYPE_LABELS, SIDE_LABELS } from '@/lib/strategy-text';
import { OrderDrawer } from './order-drawer';
import { filtersToSearch, useOrders, type LiveState, type OrderFilters } from './use-orders';

const LIVE_TEXT: Record<LiveState, string> = {
  connecting: 'Connecting to live updates…',
  live: 'Live updates on',
  reconnecting: 'Reconnecting live updates…',
};

function label(map: Record<string, string>, key: string) {
  return map[key] ?? key;
}

function errorText(e: unknown, fallback: string) {
  return e instanceof ApiError ? e.message : fallback;
}

// ---------------------------------------------------------------------------
// Kill switch, paused strategies and running strategies
// ---------------------------------------------------------------------------

function ExecutionBanner({
  status,
  onChanged,
}: {
  status: ExecutionStatusDto;
  onChanged: () => void;
}) {
  const [dialog, setDialog] = useState<null | 'release' | 'cancel-all'>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const paused = status.runtimes.filter((r) => r.status === 'paused');
  const working = status.runtimes.reduce((n, r) => n + r.workingOrders, 0);

  async function run(fn: () => Promise<string>) {
    setBusy(true);
    setError(null);
    try {
      setDone(await fn());
      setDialog(null);
      onChanged();
    } catch (e) {
      setError(errorText(e, 'Something went wrong. Try again.'));
    } finally {
      setBusy(false);
    }
  }

  if (!status.halted && paused.length === 0 && !done) return null;
  return (
    <div className="mb-4 space-y-2">
      {status.halted && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-3 rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-sm text-warn"
        >
          <span className="font-semibold">All trading is paused.</span>
          <span>
            The kill switch stops every strategy from sending new orders. Working orders stay open
            until you cancel them.
            {status.halted.reason ? ` Reason: ${status.halted.reason}.` : ''}
          </span>
          <span className="ml-auto flex gap-2">
            <Button
              size="sm"
              variant="danger"
              disabled={working === 0}
              onClick={() => setDialog('cancel-all')}
            >
              Cancel all working orders
            </Button>
            <Button size="sm" onClick={() => setDialog('release')}>
              Release kill switch
            </Button>
          </span>
        </div>
      )}
      {paused
        .filter((r) => !status.halted || r.pauseReason !== 'Kill switch engaged')
        .map((r) => (
          <div
            key={r.id}
            role="status"
            className="flex flex-wrap items-center gap-3 rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-sm text-warn"
          >
            <span>
              <span className="font-semibold">{r.strategyName} is paused.</span>{' '}
              {r.pauseReason ?? ''}
            </span>
            <Button
              size="sm"
              className="ml-auto"
              disabled={busy || status.halted !== null}
              onClick={() =>
                void run(async () => {
                  await apiClient.execution.resume(r.id);
                  return `${r.strategyName} resumed.`;
                })
              }
            >
              Resume {r.strategyName}
            </Button>
          </div>
        ))}
      {done && <Alert tone="ok">{done}</Alert>}
      {error && !dialog && <Alert>{error}</Alert>}
      <Dialog
        open={dialog === 'cancel-all'}
        onClose={() => setDialog(null)}
        title="Cancel all working orders?"
        description={`Requests a cancel for ${working === 1 ? 'the 1 working order' : `all ${working} working orders`} across your strategies. Positions are not closed.`}
      >
        {error && <Alert>{error}</Alert>}
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={() => setDialog(null)}>Keep orders</Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const { requested } = await apiClient.orders.cancelAll();
                return `Cancel requested for ${requested} ${requested === 1 ? 'order' : 'orders'}.`;
              })
            }
          >
            {busy ? 'Canceling…' : 'Cancel all orders'}
          </Button>
        </div>
      </Dialog>
      <Dialog
        open={dialog === 'release'}
        onClose={() => setDialog(null)}
        title="Release the kill switch?"
        description="Strategies stay paused. Resume each one when you are ready."
      >
        {error && <Alert>{error}</Alert>}
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={() => setDialog(null)}>Keep paused</Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await apiClient.execution.killSwitch({ engaged: false });
                return 'Kill switch released. Paused strategies stay paused until you resume them.';
              })
            }
          >
            Release
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

function KillSwitchButton({
  status,
  onChanged,
}: {
  status: ExecutionStatusDto | null;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!status || status.halted) return null;
  return (
    <>
      <Button variant="danger" onClick={() => setOpen(true)}>
        Pause all trading
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Pause all trading?"
        description="The kill switch stops every strategy from sending new orders. It cancels nothing; you can cancel working orders separately afterwards."
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            apiClient.execution
              .killSwitch({ engaged: true, ...(reason.trim() ? { reason: reason.trim() } : {}) })
              .then(
                () => {
                  setOpen(false);
                  onChanged();
                },
                (err: unknown) => setError(errorText(err, 'Could not pause trading.')),
              )
              .finally(() => setBusy(false));
          }}
        >
          <TextField
            label="Reason (optional)"
            name="kill-reason"
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
          />
          {error && (
            <div className="mt-3">
              <Alert>{error}</Alert>
            </div>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" variant="danger" disabled={busy}>
              {busy ? 'Pausing…' : 'Pause all trading'}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

function Runtimes({
  status,
  highlight,
  when,
  onShow,
}: {
  status: ExecutionStatusDto;
  highlight: string | undefined;
  when: (iso: string) => string;
  onShow: (runtimeId: string) => void;
}) {
  if (status.runtimes.length === 0) return null;
  return (
    <section aria-labelledby="runtimes-heading" className="mb-6">
      <h2 id="runtimes-heading" className="mb-2 text-lg font-semibold">
        Strategies on paper
      </h2>
      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {status.runtimes.map((r) => {
          const s = RUNTIME_STATUS[r.status];
          const isNew = highlight === r.strategyId && r.status !== 'stopped';
          return (
            <li
              key={r.id}
              aria-label={`${r.strategyName}${isNew ? ', just started' : ''}`}
              className={cx(
                'rounded-lg border bg-surface p-3 text-sm',
                isNew ? 'border-accent ring-2 ring-accent/40' : 'border-line',
              )}
            >
              <div className="flex flex-wrap items-center gap-2">
                <Link href={`/strategy-lab/${r.strategyId}`} className="font-semibold underline">
                  {r.strategyName}
                </Link>
                <Badge tone={s.tone}>{s.label}</Badge>
                {isNew && <Badge tone="info">Just started</Badge>}
              </div>
              <p className="mt-1 text-ink-muted">
                Started {when(r.startedAt)} ·{' '}
                {r.workingOrders === 1 ? '1 working order' : `${r.workingOrders} working orders`}
              </p>
              <Button size="sm" variant="ghost" className="mt-1 -ml-3" onClick={() => onShow(r.id)}>
                Show its orders
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

function OrdersTable({
  orders,
  when,
  onOpen,
  onCycle,
}: {
  orders: OrderRowDto[];
  when: (iso: string | null) => string;
  onOpen: (id: string) => void;
  onCycle: (o: OrderRowDto) => void;
}) {
  return (
    <Table label="Orders">
      <thead>
        <tr>
          <Th>Order</Th>
          <Th>Strategy</Th>
          <Th>Phase</Th>
          <Th>Instrument</Th>
          <Th>Side</Th>
          <Th className="text-right">Filled / qty</Th>
          <Th>Type</Th>
          <Th>Status</Th>
          <Th>Submitted</Th>
          <Th>Filled</Th>
          <Th className="text-right">Avg price</Th>
          <Th>Account</Th>
          <Th>Mode</Th>
        </tr>
      </thead>
      <tbody>
        {orders.map((o) => {
          const s = ORDER_STATE[o.state];
          return (
            <tr key={o.id} className="hover:bg-surface-2">
              <Td>
                <button
                  type="button"
                  className="text-left font-medium underline"
                  onClick={() => onOpen(o.id)}
                >
                  {o.legLabel}
                  <span className="sr-only"> details</span>
                </button>
                {o.source !== 'strategy' && (
                  <span className="ml-1 text-xs text-ink-muted">
                    ({SOURCE_LABELS[o.source].toLowerCase()})
                  </span>
                )}
              </Td>
              <Td>
                <Link href={`/strategy-lab/${o.strategyId}`} className="underline">
                  {o.strategyName}
                </Link>{' '}
                <button
                  type="button"
                  className="text-xs text-ink-muted underline"
                  onClick={() => onCycle(o)}
                >
                  cycle {o.cycleSeq}
                </button>
              </Td>
              <Td>{PHASE_LABELS[o.phase]}</Td>
              <Td>{o.symbol}</Td>
              <Td>{label(SIDE_LABELS, o.side)}</Td>
              <Td className="text-right tabular-nums">
                {o.filledQuantity} / {o.quantity}
              </Td>
              <Td>
                {label(ORDER_TYPE_LABELS, o.orderType)}
                {o.limitPrice ? ` ${formatPrice(o.limitPrice)}` : ''}
              </Td>
              <Td>
                <Badge tone={s.tone}>{s.label}</Badge>
                {o.cancelRequested && o.state !== 'canceled' && (
                  <span className="ml-1 text-xs text-ink-muted">cancel requested</span>
                )}
              </Td>
              <Td className="whitespace-nowrap">{when(o.submittedAt)}</Td>
              <Td className="whitespace-nowrap">{when(o.filledAt)}</Td>
              <Td className="text-right tabular-nums">{formatPrice(o.averagePrice)}</Td>
              <Td>{o.accountName}</Td>
              <Td>{o.mode === 'paper' ? 'Paper' : 'Live'}</Td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}

function ScheduledTable({
  rows,
  when,
}: {
  rows: ScheduledRowDto[];
  when: (iso: string | null) => string;
}) {
  return (
    <Table label="Scheduled legs">
      <thead>
        <tr>
          <Th>Leg</Th>
          <Th>Strategy</Th>
          <Th>Phase</Th>
          <Th>Instrument</Th>
          <Th>Side</Th>
          <Th>Due</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <Td className="font-medium">{r.legLabel}</Td>
            <Td>
              {r.strategyName} <span className="text-xs text-ink-muted">cycle {r.cycleSeq}</span>
            </Td>
            <Td>{PHASE_LABELS[r.phase]}</Td>
            <Td>{r.symbol ?? '—'}</Td>
            <Td>{r.side ? label(SIDE_LABELS, r.side) : '—'}</Td>
            <Td className="whitespace-nowrap">{when(r.dueAt)}</Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function Positions({
  positions,
  when,
  onChanged,
}: {
  positions: PositionDto[];
  when: (iso: string | null) => string;
  onChanged: () => void;
}) {
  const [closing, setClosing] = useState<PositionDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <section aria-labelledby="positions-heading" className="mt-8">
      <h2 id="positions-heading" className="mb-2 text-lg font-semibold">
        Positions
      </h2>
      {positions.length === 0 ? (
        <p className="text-sm text-ink-muted">No open positions.</p>
      ) : (
        <Table label="Positions">
          <thead>
            <tr>
              <Th>Strategy</Th>
              <Th>Instrument</Th>
              <Th className="text-right">Position</Th>
              <Th className="text-right">Avg cost</Th>
              <Th className="text-right">Last fill</Th>
              <Th>Account</Th>
              <Th>Strategy status</Th>
              <Th>
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => (
              <tr key={`${p.runtimeId}:${p.instrumentId}`}>
                <Td>
                  <Link href={`/strategy-lab/${p.strategyId}`} className="underline">
                    {p.strategyName}
                  </Link>
                </Td>
                <Td>{p.symbol}</Td>
                <Td className="text-right tabular-nums">{describeHolding(p.quantity)}</Td>
                <Td className="text-right tabular-nums">{formatPrice(p.averageCost)}</Td>
                <Td className="text-right tabular-nums">
                  {formatPrice(p.lastFillPrice)}{' '}
                  <span className="text-xs text-ink-muted">{when(p.lastFillAt)}</span>
                </Td>
                <Td>{p.accountName}</Td>
                <Td>
                  <Badge tone={RUNTIME_STATUS[p.runtimeStatus].tone}>
                    {RUNTIME_STATUS[p.runtimeStatus].label}
                  </Badge>
                </Td>
                <Td>
                  {p.closing ? (
                    <span className="text-xs text-ink-muted">Close order working</span>
                  ) : p.runtimeStatus === 'stopped' ? (
                    <Button size="sm" variant="danger" onClick={() => setClosing(p)}>
                      Close {p.symbol}
                    </Button>
                  ) : (
                    <span className="text-xs text-ink-muted">Managed by its Exit rules</span>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <Dialog
        open={closing !== null}
        onClose={() => setClosing(null)}
        title={closing ? `Close ${closing.symbol} position?` : 'Close position?'}
        description={
          closing
            ? `Sends a market order to ${Number(closing.quantity) > 0 ? 'sell' : 'buy back'} ${describeHolding(closing.quantity).toLowerCase()} for ${closing.strategyName}. It is recorded as your order, not the strategy's.`
            : undefined
        }
      >
        {error && <Alert>{error}</Alert>}
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={() => setClosing(null)}>Keep position</Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => {
              if (!closing) return;
              setBusy(true);
              setError(null);
              apiClient.positions
                .close({ runtimeId: closing.runtimeId, instrumentId: closing.instrumentId })
                .then(
                  () => {
                    setClosing(null);
                    onChanged();
                  },
                  (e: unknown) => setError(errorText(e, 'Could not close the position.')),
                )
                .finally(() => setBusy(false));
            }}
          >
            {busy ? 'Sending…' : 'Close position'}
          </Button>
        </div>
      </Dialog>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export function OrdersView({
  prefs,
  initialFilters,
  started,
  strategies,
  instruments,
}: {
  prefs: DisplayPreferences;
  initialFilters: OrderFilters;
  /** Strategy just started from the Strategy Lab, to highlight (§15.2). */
  started: string | undefined;
  strategies: { id: string; name: string }[];
  instruments: { id: string; symbol: string }[];
}) {
  const [filters, setFilters] = useState<OrderFilters>(initialFilters);
  const [openId, setOpenId] = useState<string | null>(null);
  const data = useOrders(filters, prefs.timeZone);
  const symbols = useMemo(() => new Map(instruments.map((i) => [i.id, i.symbol])), [instruments]);

  useEffect(() => {
    const search = filtersToSearch(filters, new URLSearchParams(window.location.search));
    window.history.replaceState(null, '', `${window.location.pathname}${search}`);
  }, [filters]);

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
  const set = (patch: Partial<OrderFilters>) => setFilters((f) => ({ ...f, ...patch }));
  const counts = data.list?.counts;
  const scoped = filters.runtimeId || filters.cycleId;
  const runtimeName = data.status?.runtimes.find((r) => r.id === filters.runtimeId)?.strategyName;

  return (
    <>
      <PageHeader
        title="Orders"
        description="Orders generated by your strategies, with their full history."
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <ModeBadge mode="paper" />
            <span role="status" className="text-sm text-ink-muted">
              {LIVE_TEXT[data.live]}
            </span>
            <KillSwitchButton status={data.status} onChanged={data.refresh} />
          </div>
        }
      />
      {data.status && <ExecutionBanner status={data.status} onChanged={data.refresh} />}
      {data.error && (
        <div className="mb-4">
          <Alert>{data.error}</Alert>
        </div>
      )}
      {data.status && (
        <Runtimes
          status={data.status}
          highlight={started}
          when={(iso) => when(iso)}
          onShow={(runtimeId) => set({ runtimeId, cycleId: undefined })}
        />
      )}

      <nav aria-label="Order views" className="mb-3 flex flex-wrap gap-2">
        {ORDER_VIEWS.map((v) => (
          <Button
            key={v}
            size="sm"
            variant={filters.view === v ? 'primary' : 'secondary'}
            aria-pressed={filters.view === v}
            onClick={() => set({ view: v })}
          >
            {VIEW_LABELS[v]}
            <span className="tabular-nums">{counts ? counts[v] : '…'}</span>
          </Button>
        ))}
      </nav>

      <form
        role="search"
        aria-label="Filter orders"
        className="mb-4 grid grid-cols-2 items-end gap-3 sm:grid-cols-3 lg:grid-cols-5"
        onSubmit={(e) => e.preventDefault()}
      >
        <SelectField
          label="Strategy"
          name="strategy"
          value={filters.strategyId ?? ''}
          onChange={(e) => set({ strategyId: e.target.value || undefined })}
        >
          <option value="">Any strategy</option>
          {strategies.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Phase"
          name="phase"
          value={filters.phase ?? ''}
          onChange={(e) => set({ phase: (e.target.value || undefined) as OrderFilters['phase'] })}
        >
          <option value="">Entry and Exit</option>
          <option value="entry">Entry</option>
          <option value="exit">Exit</option>
          <option value="flatten">Close</option>
        </SelectField>
        <SelectField
          label="Instrument"
          name="asset"
          value={filters.instrumentId ?? ''}
          onChange={(e) => set({ instrumentId: e.target.value || undefined })}
        >
          <option value="">Any instrument</option>
          {instruments.map((i) => (
            <option key={i.id} value={i.id}>
              {i.symbol}
            </option>
          ))}
        </SelectField>
        <TextField
          label="From"
          name="from"
          type="date"
          value={filters.from ?? ''}
          onChange={(e) => set({ from: e.target.value || undefined })}
        />
        <TextField
          label="To"
          name="to"
          type="date"
          value={filters.to ?? ''}
          onChange={(e) => set({ to: e.target.value || undefined })}
        />
      </form>
      {scoped && (
        <p className="mb-3 flex flex-wrap items-center gap-2 text-sm">
          Showing{' '}
          {filters.cycleId
            ? `one cycle${runtimeName ? ` of ${runtimeName}` : ''}`
            : `one run${runtimeName ? ` of ${runtimeName}` : ''}`}
          .
          <Button
            size="sm"
            variant="ghost"
            onClick={() => set({ runtimeId: undefined, cycleId: undefined })}
          >
            Show all runs
          </Button>
        </p>
      )}

      {!data.list ? (
        <p className="text-sm">Loading orders…</p>
      ) : data.list.counts.all === 0 && data.list.counts.scheduled === 0 && !scoped ? (
        <EmptyState icon={<OrdersIcon />} title="No orders yet">
          Orders appear here once a strategy is running on paper. Build and test a strategy in the
          Strategy Lab, then start it from its Back Test panel.
        </EmptyState>
      ) : (
        <div className="space-y-4">
          {data.list.scheduled.length > 0 && (
            <section aria-labelledby="scheduled-heading">
              <h2 id="scheduled-heading" className="mb-2 text-sm font-semibold">
                Waiting on timing
              </h2>
              <ScheduledTable rows={data.list.scheduled} when={when} />
            </section>
          )}
          {filters.view !== 'scheduled' &&
            (data.list.orders.length === 0 ? (
              <p className="text-sm text-ink-muted">No orders match these filters.</p>
            ) : (
              <OrdersTable
                orders={data.list.orders}
                when={when}
                onOpen={setOpenId}
                onCycle={(o) => set({ runtimeId: o.runtimeId, cycleId: o.cycleId })}
              />
            ))}
          {filters.view === 'scheduled' && data.list.scheduled.length === 0 && (
            <p className="text-sm text-ink-muted">No legs are waiting on timing.</p>
          )}
        </div>
      )}

      {data.positions && (
        <Positions positions={data.positions} when={when} onChanged={data.refresh} />
      )}

      <OrderDrawer
        orderId={openId}
        version={data.version}
        prefs={prefs}
        symbols={symbols}
        onClose={() => setOpenId(null)}
        onChanged={data.refresh}
      />
    </>
  );
}
