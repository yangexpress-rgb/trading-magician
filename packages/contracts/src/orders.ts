import type { OrderState, PlannedOrder, StrategyDefinition } from '@tm/domain';
import { z } from 'zod';

/**
 * Request and response shapes for orders, positions and execution controls
 * (Design v1.0 §8.1, §8.3, §14.3). Decimals travel as strings, times as ISO
 * 8601 UTC; the browser shows them in the viewer's time zone.
 */

export const ORDER_VIEWS = ['all', 'working', 'filled', 'closed', 'scheduled'] as const;
export type OrderViewDto = (typeof ORDER_VIEWS)[number];
export const ORDER_PHASES = ['entry', 'exit', 'flatten'] as const;

const TIME_ZONES = new Set([...Intl.supportedValuesOf('timeZone'), 'UTC']);

/** Query string for GET /orders. Dates are calendar days in `tz`, inclusive. */
export const listOrdersQuery = z.object({
  view: z.enum(ORDER_VIEWS).default('all'),
  strategyId: z.uuid().optional(),
  runtimeId: z.uuid().optional(),
  cycleId: z.uuid().optional(),
  phase: z.enum(ORDER_PHASES).optional(),
  instrumentId: z.uuid().optional(),
  accountId: z.uuid().optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  tz: z
    .string()
    .refine((tz) => TIME_ZONES.has(tz), 'Choose a valid time zone')
    .default('UTC'),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export type ListOrdersQuery = z.input<typeof listOrdersQuery>;

export const closePositionsRequest = z
  .object({ runtimeId: z.uuid(), instrumentId: z.uuid().optional() })
  .strict();
export type ClosePositionsRequest = z.input<typeof closePositionsRequest>;

export const killSwitchRequest = z
  .object({ engaged: z.boolean(), reason: z.string().trim().max(500).optional() })
  .strict();
export type KillSwitchRequest = z.input<typeof killSwitchRequest>;

export const cancelAllRequest = z.object({ confirmed: z.literal(true) }).strict();

export interface OrderRowDto {
  id: string;
  mode: 'paper' | 'live';
  /** Who created it: the strategy, a person, or the system (flattening). */
  source: 'strategy' | 'user' | 'system';
  strategyId: string;
  strategyName: string;
  runtimeId: string;
  cycleId: string;
  cycleSeq: number;
  phase: 'entry' | 'exit' | 'flatten';
  legLabel: string;
  instrumentId: string;
  symbol: string;
  side: string;
  quantity: string;
  orderType: string;
  limitPrice: string | null;
  stopPrice: string | null;
  timeInForce: string;
  state: OrderState;
  filledQuantity: string;
  averagePrice: string | null;
  accountId: string;
  accountName: string;
  reason: string | null;
  cancelRequested: boolean;
  createdAt: string;
  submittedAt: string | null;
  filledAt: string | null;
  terminalAt: string | null;
}

export interface ScheduledRowDto {
  id: string;
  strategyId: string;
  strategyName: string;
  runtimeId: string;
  cycleId: string;
  cycleSeq: number;
  phase: 'entry' | 'exit' | 'flatten';
  legId: string | null;
  legLabel: string;
  symbol: string | null;
  side: string | null;
  dueAt: string;
}

export interface OrderListDto {
  orders: OrderRowDto[];
  scheduled: ScheduledRowDto[];
  counts: Record<OrderViewDto, number>;
}

export interface OrderDetailDto extends OrderRowDto {
  versionId: string;
  versionNo: number | null;
  attempt: number;
  idempotencyKey: string;
  brokerOrderId: string | null;
  rawStatus: string | null;
  eligibleAt: string;
  referencePrice: string;
  extendedHours: boolean;
  fees: string;
  risk: {
    ok: boolean;
    code?: string;
    checks: { code: string; passed: boolean; limit?: string; value?: string }[];
  };
  sourceRule: {
    plannedOrder: PlannedOrder | null;
    condition: StrategyDefinition['entry']['condition'] | null;
    trigger: StrategyDefinition['entry']['trigger'] | null;
  };
  triggerEvent: {
    id: string;
    result: string;
    qualified: boolean;
    dataTime: string;
    evaluatedAt: string;
    values: Record<string, unknown>;
  } | null;
  fills: { id: string; quantity: string; price: string; fee: string; filledAt: string }[];
  timeline: {
    seq: number;
    source: string;
    fromState: OrderState | null;
    toState: OrderState | null;
    kind: string;
    detail: Record<string, unknown>;
    providerAt: string | null;
    receivedAt: string;
  }[];
}

export interface PositionDto {
  runtimeId: string;
  runtimeStatus: 'running' | 'paused' | 'stopped';
  strategyId: string;
  strategyName: string;
  instrumentId: string;
  symbol: string;
  accountId: string;
  accountName: string;
  quantity: string;
  averageCost: string | null;
  lastFillPrice: string;
  lastFillAt: string;
  closing: boolean;
}

export interface PositionListDto {
  positions: PositionDto[];
}

export interface RuntimeSummaryDto {
  id: string;
  strategyId: string;
  strategyName: string;
  status: 'running' | 'paused' | 'stopped';
  pauseReason: string | null;
  startedAt: string;
  stoppedAt: string | null;
  workingOrders: number;
}

export const INCIDENT_KINDS = [
  'reconciliation_mismatch',
  'repeated_rejects',
  'stale_data',
  'feed_loss',
  'broker_disconnected',
] as const;
export type IncidentKindDto = (typeof INCIDENT_KINDS)[number];

export interface IncidentDto {
  id: string;
  kind: IncidentKindDto;
  runtimeId: string | null;
  accountId: string | null;
  summary: string;
  details: Record<string, unknown>;
  pausedRuntimes: number;
  openedAt: string;
}

export const resolveIncidentRequest = z
  .object({ note: z.string().trim().max(500).optional() })
  .strict();
export type ResolveIncidentRequest = z.input<typeof resolveIncidentRequest>;

export interface ExecutionStatusDto {
  halted: { at: string; reason: string | null } | null;
  runtimes: RuntimeSummaryDto[];
  /** Open incidents: reconciliation mismatches, repeated rejects, data and broker problems. */
  incidents: IncidentDto[];
}

// ---------------------------------------------------------------------------
// Notifications (§16.3)

export const NOTIFICATION_KINDS = [
  'strategy_started',
  'strategy_stopped',
  'triggered',
  'order_rejected',
  'partial_fill',
  'filled',
  'disconnect',
  'stale_data',
  'risk_pause',
  'reconciliation_mismatch',
] as const;
export type NotificationKindDto = (typeof NOTIFICATION_KINDS)[number];

export interface NotificationDto {
  id: string;
  kind: NotificationKindDto;
  title: string;
  body: string;
  /** An in-app path. */
  link: string | null;
  createdAt: string;
  read: boolean;
}

export interface NotificationListDto {
  notifications: NotificationDto[];
  unread: number;
}

export const listNotificationsQuery = z.object({
  unread: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const markNotificationsReadRequest = z.union([
  z.object({ all: z.literal(true) }).strict(),
  z.object({ ids: z.array(z.uuid()).min(1).max(200) }).strict(),
]);
export type MarkNotificationsReadRequest = z.input<typeof markNotificationsReadRequest>;
