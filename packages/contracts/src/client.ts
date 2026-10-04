import { ApiError, type ApiErrorBody } from './errors';
import type {
  CreateStrategyRequest,
  ListStrategiesQuery,
  PublishVersionDto,
  StartStrategyRequest,
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
  return {
    strategies: {
      list(query: ListStrategiesQuery = {}) {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(query)) {
          if (value === undefined) continue;
          for (const v of Array.isArray(value) ? value : [value]) params.append(key, String(v));
        }
        const qs = params.toString();
        return call<StrategyListDto>('GET', `/strategies${qs ? `?${qs}` : ''}`);
      },
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
      stop: (id: string, body: { rowVersion: number; reason?: string }) =>
        call<StrategyDetailDto>('POST', `/strategies/${enc(id)}/stop`, body),
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
