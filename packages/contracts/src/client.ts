import type {
  BacktestListDto,
  BacktestRunDto,
  BacktestTradesDto,
  StartBacktestRequest,
} from './backtests';
import { ApiError, type ApiErrorBody } from './errors';
import type {
  ClosePositionsRequest,
  ExecutionStatusDto,
  KillSwitchRequest,
  ListOrdersQuery,
  MarkNotificationsReadRequest,
  NotificationListDto,
  OrderDetailDto,
  OrderListDto,
  PositionListDto,
} from './orders';
import type {
  CreateStrategyRequest,
  ListStrategiesQuery,
  PublishVersionDto,
  StartStrategyRequest,
  StopStrategyRequest,
  StrategyDetailDto,
  StrategyListDto,
  StrategyVersionDto,
  UpdateStrategyRequest,
  ValidateStrategyDto,
} from './strategies';

type Fetch = typeof fetch;

/**
 * Thin typed client for /api/v1. Same-origin by default, so the browser sends
 * the session cookie; the server is the only place that checks it.
 */
export function createApiClient(options: { baseUrl?: string; fetch?: Fetch } = {}) {
  const base = `${options.baseUrl ?? ''}/api/v1`;
  const doFetch: Fetch = options.fetch ?? ((...args) => fetch(...args));

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await doFetch(`${base}${path}`, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (res.status === 204) return undefined as T;
    const json = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) {
      const error = (json as ApiErrorBody | null)?.error ?? {
        code: 'internal' as const,
        message: 'Something went wrong. Try again.',
      };
      throw new ApiError(res.status, error);
    }
    return json as T;
  }

  const enc = encodeURIComponent;
  const query = (q: Record<string, unknown>) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(q)) {
      if (value === undefined) continue;
      for (const v of Array.isArray(value) ? value : [value]) params.append(key, String(v));
    }
    const qs = params.toString();
    return qs ? `?${qs}` : '';
  };
  return {
    strategies: {
      list: (q: ListStrategiesQuery = {}) => call<StrategyListDto>('GET', `/strategies${query(q)}`),
      get: (id: string) => call<StrategyDetailDto>('GET', `/strategies/${enc(id)}`),
      create: (body: CreateStrategyRequest) => call<StrategyDetailDto>('POST', '/strategies', body),
      update: (id: string, body: UpdateStrategyRequest) =>
        call<StrategyDetailDto>('PATCH', `/strategies/${enc(id)}`, body),
      remove: (id: string, rowVersion: number) =>
        call<undefined>('DELETE', `/strategies/${enc(id)}`, { rowVersion }),
      duplicate: (id: string, body: { name?: string } = {}) =>
        call<StrategyDetailDto>('POST', `/strategies/${enc(id)}/duplicate`, body),
      publishVersion: (id: string, rowVersion: number) =>
        call<PublishVersionDto>('POST', `/strategies/${enc(id)}/versions`, { rowVersion }),
      getVersion: (id: string, versionNo: number) =>
        call<StrategyVersionDto>('GET', `/strategies/${enc(id)}/versions/${versionNo}`),
      validate: (id: string) =>
        call<ValidateStrategyDto>('POST', `/strategies/${enc(id)}/validate`),
      start: (id: string, body: StartStrategyRequest) =>
        call<StrategyDetailDto>('POST', `/strategies/${enc(id)}/start`, body),
      stop: (id: string, body: StopStrategyRequest) =>
        call<StrategyDetailDto>('POST', `/strategies/${enc(id)}/stop`, body),
    },
    backtests: {
      start: (strategyId: string, body: StartBacktestRequest) =>
        call<BacktestRunDto>('POST', `/strategies/${enc(strategyId)}/backtests`, body),
      list: (strategyId: string) =>
        call<BacktestListDto>('GET', `/strategies/${enc(strategyId)}/backtests`),
      get: (runId: string) => call<BacktestRunDto>('GET', `/backtests/${enc(runId)}`),
      cancel: (runId: string) => call<BacktestRunDto>('POST', `/backtests/${enc(runId)}/cancel`),
      trades: (runId: string) => call<BacktestTradesDto>('GET', `/backtests/${enc(runId)}/trades`),
      /** Same-origin link for the CSV download. */
      exportUrl: (runId: string) => `${base}/backtests/${enc(runId)}/export`,
    },
    orders: {
      list: (q: ListOrdersQuery = {}) => call<OrderListDto>('GET', `/orders${query(q)}`),
      get: (id: string) => call<OrderDetailDto>('GET', `/orders/${enc(id)}`),
      cancel: (id: string) => call<OrderDetailDto>('POST', `/orders/${enc(id)}/cancel`),
      cancelAll: () =>
        call<{ requested: number }>('POST', '/orders/cancel-all', { confirmed: true }),
      /** Server-sent events: a `change` event whenever the user's orders may have changed. */
      streamUrl: () => `${base}/orders/stream`,
    },
    positions: {
      list: () => call<PositionListDto>('GET', '/positions'),
      close: (body: ClosePositionsRequest) =>
        call<{ orders: number }>('POST', '/positions/close', body),
    },
    execution: {
      status: () => call<ExecutionStatusDto>('GET', '/execution'),
      killSwitch: (body: KillSwitchRequest) =>
        call<ExecutionStatusDto>('POST', '/execution/kill-switch', body),
      resume: (runtimeId: string) =>
        call<ExecutionStatusDto>('POST', `/execution/runtimes/${enc(runtimeId)}/resume`),
      resolveIncident: (incidentId: string, body: { note?: string } = {}) =>
        call<ExecutionStatusDto>('POST', `/execution/incidents/${enc(incidentId)}/resolve`, body),
    },
    notifications: {
      list: (q: { unread?: boolean; limit?: number } = {}) =>
        call<NotificationListDto>('GET', `/notifications${query(q)}`),
      markRead: (body: MarkNotificationsReadRequest) =>
        call<{ marked: number }>('POST', '/notifications/read', body),
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
