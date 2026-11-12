import type {
  BacktestListDto,
  BacktestRunDto,
  BacktestTradesDto,
  StartBacktestRequest,
} from './backtests';
import type {
  BillingRedirectDto,
  CheckoutSessionRequest,
  EntitlementDto,
  PlanListDto,
  SubscriptionDto,
} from './billing';
import { ApiError, type ApiErrorBody } from './errors';
import type {
  PerformanceQuery,
  PerformanceSummaryDto,
  PerformanceTimeseriesDto,
  PerformanceTradesDto,
} from './performance';
import type {
  CreateFeedRequest,
  CreateRouteRequest,
  FeedDto,
  CustomFeedTestDto,
  CustomFeedTestRequest,
  FeedListDto,
  RouteDto,
  SetFeedActiveRequest,
  SetFeedSharingRequest,
  UpdateFeedRequest,
  UpdateRouteRequest,
  CreateCredentialRequest,
  CredentialDto,
  CredentialListDto,
  RenameCredentialRequest,
  RotateCredentialRequest,
  CreateInstrumentLookupRequest,
  InstrumentLookupDto,
  AccountUpdateDto,
  CreatePlatformRequest,
  PlatformDto,
  PlatformListDto,
  SetPlatformActiveRequest,
  UpdateAccountRequest,
  UpdatePlatformRequest,
  AccountDto,
} from './integrations';
import type {
  CompanyReportDto,
  CreateCompanyReportRequest,
  CreateOptionChainRequest,
  CreatePriceChartRequest,
  OptionChainDto,
  OptionHistoryDto,
  CreateStockScreenRequest,
  DealListDto,
  EarningsDto,
  PriceChartDto,
  StockScreenDataDto,
  StockScreenDto,
} from './research';
import type {
  ClosePositionsRequest,
  ExecutionStatusDto,
  KillSwitchRequest,
  ListOrdersQuery,
  MarkNotificationsReadRequest,
  NotificationPrefsDto,
  UpdateNotificationPrefsRequest,
  NotificationListDto,
  OrderDetailDto,
  OrderListDto,
  PositionListDto,
} from './orders';
import type {
  ConventionListDto,
  EditLibraryEntryRequest,
  LibraryEntryDto,
  LibraryListDto,
  ListLibraryQuery,
  NextNumberDto,
  RegisteredLibraryEntryDto,
  RegisterLibraryEntryRequest,
} from './library';
import type {
  AcceptedShareDto,
  ShareDetailDto,
  ShareListDto,
  ShareMemberDto,
  ShareStatusDto,
  CreateShareRequest,
} from './sharing';
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
    library: {
      list: (q: ListLibraryQuery = {}) => call<LibraryListDto>('GET', `/library${query(q)}`),
      get: (number: string) => call<LibraryEntryDto>('GET', `/library/${enc(number)}`),
      conventions: () => call<ConventionListDto>('GET', '/library/conventions'),
      nextNumber: (q: { recordType?: string; timeframe: string; asset: string }) =>
        call<NextNumberDto>('GET', `/library/next-number${query(q)}`),
      register: (body: RegisterLibraryEntryRequest) =>
        call<RegisteredLibraryEntryDto>('POST', '/library', body),
      update: (number: string, body: EditLibraryEntryRequest) =>
        call<{ registrationNumber: string; rowVersion: number; changedFields: string[] }>(
          'PATCH',
          `/library/${enc(number)}`,
          body,
        ),
      retire: (number: string, body: { reason: string; rowVersion: number }) =>
        call<{ registrationNumber: string; rowVersion: number }>(
          'POST',
          `/library/${enc(number)}/retire`,
          body,
        ),
    },
    strategies: {
      list: (q: ListStrategiesQuery = {}) => call<StrategyListDto>('GET', `/strategies${query(q)}`),
      get: (id: string) => call<StrategyDetailDto>('GET', `/strategies/${enc(id)}`),
      create: (body: CreateStrategyRequest) => call<StrategyDetailDto>('POST', '/strategies', body),
      update: (id: string, body: UpdateStrategyRequest) =>
        call<StrategyDetailDto>('PATCH', `/strategies/${enc(id)}`, body),
      remove: (id: string, rowVersion: number) =>
        call<undefined>('DELETE', `/strategies/${enc(id)}`, { rowVersion }),
      duplicate: (id: string, body: { name?: string; description?: string } = {}) =>
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
    performance: {
      summary: (q: PerformanceQuery = {}) =>
        call<PerformanceSummaryDto>('GET', `/performance/summary${query(q)}`),
      timeseries: (q: PerformanceQuery = {}) =>
        call<PerformanceTimeseriesDto>('GET', `/performance/timeseries${query(q)}`),
      trades: (q: PerformanceQuery = {}) =>
        call<PerformanceTradesDto>('GET', `/performance/trades${query(q)}`),
    },
    billing: {
      plans: () => call<PlanListDto>('GET', '/plans'),
      entitlement: () => call<EntitlementDto>('GET', '/entitlement'),
      subscription: () => call<SubscriptionDto>('GET', '/subscription'),
      checkout: (body: CheckoutSessionRequest) =>
        call<BillingRedirectDto>('POST', '/billing/checkout-session', body),
      portal: () => call<BillingRedirectDto>('POST', '/billing/portal-session'),
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
    shares: {
      list: (q: { box?: 'received' | 'sent'; status?: ShareStatusDto } = {}) =>
        call<ShareListDto>('GET', `/shares${query(q)}`),
      get: (id: string) => call<ShareDetailDto>('GET', `/shares/${enc(id)}`),
      create: (body: CreateShareRequest) => call<ShareListDto>('POST', '/shares', body),
      accept: (id: string) => call<AcceptedShareDto>('POST', `/shares/${enc(id)}/accept`),
      decline: (id: string) => call<undefined>('POST', `/shares/${enc(id)}/decline`),
      withdraw: (id: string) => call<undefined>('POST', `/shares/${enc(id)}/withdraw`),
    },
    members: {
      lookup: (q: string) =>
        call<{ member: ShareMemberDto | null }>('GET', `/members/lookup${query({ q })}`),
      list: () => call<{ items: ShareMemberDto[] }>('GET', '/members'),
    },
    notifications: {
      list: (q: { unread?: boolean; limit?: number } = {}) =>
        call<NotificationListDto>('GET', `/notifications${query(q)}`),
      markRead: (body: MarkNotificationsReadRequest) =>
        call<{ marked: number }>('POST', '/notifications/read', body),
      prefs: () => call<NotificationPrefsDto>('GET', '/notifications/preferences'),
      updatePrefs: (body: UpdateNotificationPrefsRequest) =>
        call<NotificationPrefsDto>('PUT', '/notifications/preferences', body),
    },
    credentials: {
      list: () => call<CredentialListDto>('GET', '/credentials'),
      create: (body: CreateCredentialRequest) => call<CredentialDto>('POST', '/credentials', body),
      rename: (id: string, body: RenameCredentialRequest) =>
        call<CredentialDto>('PATCH', `/credentials/${enc(id)}`, body),
      rotate: (id: string, body: RotateCredentialRequest) =>
        call<CredentialDto>('POST', `/credentials/${enc(id)}/rotate`, body),
      remove: (id: string) => call<undefined>('DELETE', `/credentials/${enc(id)}`),
    },
    feeds: {
      list: () => call<FeedListDto>('GET', '/data-feeds'),
      create: (body: CreateFeedRequest) => call<FeedDto>('POST', '/data-feeds', body),
      update: (id: string, body: UpdateFeedRequest) =>
        call<FeedDto>('PATCH', `/data-feeds/${enc(id)}`, body),
      setActive: (id: string, body: SetFeedActiveRequest) =>
        call<FeedDto>('POST', `/data-feeds/${enc(id)}/active`, body),
      test: (id: string) => call<FeedDto>('POST', `/data-feeds/${enc(id)}/test`),
      /** Tests a custom REST feed's settings before they are saved (ADR 0041). */
      testCustom: (body: CustomFeedTestRequest) =>
        call<CustomFeedTestDto>('POST', '/data-feeds/custom-tests', body),
      customTest: (id: string) =>
        call<CustomFeedTestDto>('GET', `/data-feeds/custom-tests/${enc(id)}`),
      remove: (id: string) => call<undefined>('DELETE', `/data-feeds/${enc(id)}`),
      /** An admin shares their feeds with members, or stops (N237, ADR 0084). */
      setSharing: (body: SetFeedSharingRequest) =>
        call<{ sharing: boolean }>('PUT', '/data-feeds/sharing', body),
    },
    routes: {
      create: (body: CreateRouteRequest) => call<RouteDto>('POST', '/data-routes', body),
      update: (id: string, body: UpdateRouteRequest) =>
        call<RouteDto>('PATCH', `/data-routes/${enc(id)}`, body),
      remove: (id: string) => call<undefined>('DELETE', `/data-routes/${enc(id)}`),
    },
    brokers: {
      list: () => call<PlatformListDto>('GET', '/brokers'),
      create: (body: CreatePlatformRequest) => call<PlatformDto>('POST', '/brokers', body),
      update: (id: string, body: UpdatePlatformRequest) =>
        call<PlatformDto>('PATCH', `/brokers/${enc(id)}`, body),
      setActive: (id: string, body: SetPlatformActiveRequest) =>
        call<PlatformDto>('POST', `/brokers/${enc(id)}/active`, body),
      /** Connects or reconnects: the worker checks the key and discovers accounts. */
      connect: (id: string) => call<PlatformDto>('POST', `/brokers/${enc(id)}/connect`),
      test: (id: string) => call<PlatformDto>('POST', `/brokers/${enc(id)}/test`),
      accounts: (id: string) => call<AccountDto[]>('GET', `/brokers/${enc(id)}/accounts`),
      remove: (id: string) => call<undefined>('DELETE', `/brokers/${enc(id)}`),
    },
    accounts: {
      update: (id: string, body: UpdateAccountRequest) =>
        call<AccountUpdateDto>('PATCH', `/trading-accounts/${enc(id)}`, body),
    },
    instruments: {
      /** Asks the worker to find a US stock or ETF; poll `getLookup` until it settles. */
      lookup: (body: CreateInstrumentLookupRequest) =>
        call<InstrumentLookupDto>('POST', '/instrument-lookups', body),
      getLookup: (id: string) => call<InstrumentLookupDto>('GET', `/instrument-lookups/${enc(id)}`),
    },
    research: {
      /** Asks the worker for an instrument's bars; poll `getChart` until it settles. */
      chart: (body: CreatePriceChartRequest) =>
        call<PriceChartDto>('POST', '/research/price-charts', body),
      getChart: (id: string) => call<PriceChartDto>('GET', `/research/price-charts/${enc(id)}`),
      /** Asks the worker to screen every stock the data feed covers; poll `getScreen`, then `getScreenRows`. */
      screen: (body: CreateStockScreenRequest = {}) =>
        call<StockScreenDto>('POST', '/research/stock-screens', body),
      getScreen: (id: string) => call<StockScreenDto>('GET', `/research/stock-screens/${enc(id)}`),
      getScreenRows: (id: string) =>
        call<StockScreenDataDto>('GET', `/research/stock-screens/${enc(id)}/rows`),
      /** Asks the worker for a company's profile, financials and filings; poll `getCompany`. */
      company: (body: CreateCompanyReportRequest) =>
        call<CompanyReportDto>('POST', '/research/company-reports', body),
      getCompany: (id: string) =>
        call<CompanyReportDto>('GET', `/research/company-reports/${enc(id)}`),
      /** Asks the worker for a symbol's live option chain (15-minute cache); poll `getOptionChain`. */
      optionChain: (body: CreateOptionChainRequest) =>
        call<OptionChainDto>('POST', '/research/option-chains', body),
      getOptionChain: (symbol: string) =>
        call<OptionChainDto>('GET', `/research/option-chains/${enc(symbol)}`),
      /** The symbol's recorded daily IV30 and latest signal row. */
      optionHistory: (symbol: string) =>
        call<OptionHistoryDto>('GET', `/research/option-chains/${enc(symbol)}/history`),
      /** A symbol's earnings releases and SUE from EDGAR, and the next scheduled date (ADR 0058). */
      earnings: (symbol: string) => call<EarningsDto>('GET', `/research/earnings/${enc(symbol)}`),
      /** The deal tracker's deals; active ones only unless `all`. */
      deals: (all = false) => call<DealListDto>('GET', `/research/deals${all ? '?all=1' : ''}`),
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
