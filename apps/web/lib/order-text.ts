import type {
  IncidentKindDto,
  NotificationKindDto,
  OrderDetailDto,
  OrderRowDto,
  OrderViewDto,
} from '@tm/contracts';
import type { OrderState, RiskCheckCode } from '@tm/domain';
import type { Tone } from '@tm/ui';

/** Words for orders, positions and runtimes (Design v1.0 §8.3–8.4, §15.2). */

export const ORDER_STATE: Record<OrderState, { label: string; tone: Tone }> = {
  planned: { label: 'Planned', tone: 'neutral' },
  scheduled: { label: 'Scheduled', tone: 'neutral' },
  pending_risk: { label: 'Risk check', tone: 'neutral' },
  ready: { label: 'Ready', tone: 'info' },
  submitted: { label: 'Submitted', tone: 'info' },
  acknowledged: { label: 'Working', tone: 'info' },
  partially_filled: { label: 'Partly filled', tone: 'warn' },
  filled: { label: 'Filled', tone: 'ok' },
  canceled: { label: 'Canceled', tone: 'neutral' },
  rejected: { label: 'Rejected', tone: 'danger' },
  expired: { label: 'Expired', tone: 'neutral' },
  failed: { label: 'Failed', tone: 'danger' },
};

export const VIEW_LABELS: Record<OrderViewDto, string> = {
  all: 'All',
  working: 'Working',
  filled: 'Filled',
  closed: 'Canceled or rejected',
  scheduled: 'Scheduled',
};

export const PHASE_LABELS: Record<OrderRowDto['phase'], string> = {
  entry: 'Entry',
  exit: 'Exit',
  flatten: 'Close',
};

/** Who placed the order; manual actions must read differently from the strategy's (§14.3). */
export const SOURCE_LABELS: Record<OrderRowDto['source'], string> = {
  strategy: 'Strategy',
  user: 'You',
  system: 'Safety close',
};

export const EVENT_SOURCE_LABELS: Record<string, string> = {
  app: 'App',
  broker: 'Broker',
  user: 'You',
  reconciliation: 'Reconciliation',
};

export const RUNTIME_STATUS: Record<
  'running' | 'paused' | 'stopped',
  { label: string; tone: Tone }
> = {
  running: { label: 'Running', tone: 'ok' },
  paused: { label: 'Paused', tone: 'warn' },
  stopped: { label: 'Stopped', tone: 'neutral' },
};

export const RISK_CHECK_LABELS: Record<RiskCheckCode, string> = {
  risk_active_orders: 'Active orders',
  risk_order_size: 'Order size',
  risk_exposure: 'Strategy exposure',
  buying_power: 'Buying power',
  risk_daily_loss: 'Daily loss',
  risk_drawdown: 'Drawdown',
  risk_open_positions: 'Open positions',
  risk_collar: 'Price collar',
  stale_data: 'Price age',
  market_closed: 'Market hours',
};

type TimelineItem = OrderDetailDto['timeline'][number];

/** One line for a timeline entry: what happened, in words. */
export function describeEvent(e: TimelineItem): string {
  const d = e.detail;
  const reason = typeof d.reason === 'string' ? d.reason : undefined;
  switch (e.kind) {
    case 'risk_check': {
      const code = (d.risk as { code?: string } | undefined)?.code;
      return e.toState === 'rejected'
        ? `Risk check failed${code ? `: ${riskLabel(code)}` : ''}`
        : 'Risk check passed';
    }
    case 'submitted':
      return 'Sent to the paper broker';
    case 'submit_failed':
      return `Could not be sent${reason ? `: ${reason}` : ''}`;
    case 'cancel_requested':
      return `Cancel requested${reason ? ` (${reason})` : ''}`;
    case 'canceled_before_submit':
      return `Canceled before it was sent${reason ? ` (${reason})` : ''}`;
    case 'broker_update': {
      const u = d.update as
        | { kind?: string; reason?: string; fill?: { quantity?: string; price?: string } }
        | undefined;
      switch (u?.kind) {
        case 'accepted':
          return 'Accepted by the broker';
        case 'fill':
          return u.fill?.quantity && u.fill.price
            ? `Filled ${u.fill.quantity} at ${formatPrice(u.fill.price)}`
            : 'Filled';
        case 'canceled':
          return 'Canceled at the broker';
        case 'rejected':
          return `Rejected by the broker${u.reason ? `: ${u.reason}` : ''}`;
        case 'expired':
          return 'Expired at the end of its time in force';
        default:
          return 'Broker update';
      }
    }
    default:
      return e.toState ? `Now ${ORDER_STATE[e.toState].label.toLowerCase()}` : 'Update';
  }
}

function riskLabel(code: string): string {
  return RISK_CHECK_LABELS[code as RiskCheckCode] ?? code;
}

export { riskLabel };

/** Quantity with sign words, e.g. "Long 10" or "Short 5". */
export function describeHolding(quantity: string): string {
  const n = Number(quantity);
  return n < 0 ? `Short ${String(-n)}` : `Long ${quantity}`;
}

export function formatPrice(value: string | null): string {
  if (value === null) return '—';
  return Number(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

export const INCIDENT_LABELS: Record<IncidentKindDto, string> = {
  reconciliation_mismatch: 'Reconciliation mismatch',
  repeated_rejects: 'Repeated rejections',
  stale_data: 'Stale prices',
  feed_loss: 'Live prices lost',
  broker_disconnected: 'Broker not responding',
};

export const NOTIFICATION_LABELS: Record<NotificationKindDto, { label: string; tone: Tone }> = {
  strategy_started: { label: 'Started', tone: 'ok' },
  strategy_stopped: { label: 'Stopped', tone: 'neutral' },
  triggered: { label: 'Triggered', tone: 'info' },
  order_rejected: { label: 'Rejected', tone: 'danger' },
  partial_fill: { label: 'Partly filled', tone: 'warn' },
  filled: { label: 'Filled', tone: 'ok' },
  disconnect: { label: 'Disconnected', tone: 'danger' },
  stale_data: { label: 'Stale prices', tone: 'warn' },
  risk_pause: { label: 'Paused', tone: 'warn' },
  reconciliation_mismatch: { label: 'Mismatch', tone: 'danger' },
};
