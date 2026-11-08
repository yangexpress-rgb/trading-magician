import { BrokerUnavailableError } from '@tm/domain';
import {
  ALPACA_DATA_URL,
  ALPACA_PAPER_TRADING_URL,
  assertDataUrl,
  assertPaperTradingUrl,
} from './endpoints';
import { sharedAlpacaBudget, type AlpacaRequestBudget } from './budget';

/**
 * A small Alpaca REST client (ADR 0017). It signs requests with the paper key,
 * refuses any trading host but paper, times out, and turns failures into
 * errors that never carry the key: unreachable or throttled is retryable,
 * a refused key is reported as such, and anything else is the request's fault.
 */

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface AlpacaCredentials {
  keyId: string;
  secretKey: string;
}

export interface AlpacaClientOptions {
  credentials: AlpacaCredentials;
  fetch?: Fetch | undefined;
  tradingUrl?: string | undefined;
  dataUrl?: string | undefined;
  /** Tests only: allows a local fake in place of Alpaca's hosts. */
  allowLocal?: boolean | undefined;
  timeoutMs?: number | undefined;
  /**
   * Background work (the options recording) waits for room in the key's
   * request budget, so it never crowds out strategies or screens (ADR 0052).
   */
  background?: boolean | undefined;
  /** Tests only: a budget of their own in place of the process's shared one. */
  budget?: AlpacaRequestBudget | undefined;
}

/** Alpaca could not be reached, timed out or is throttling; try again later. */
export class AlpacaUnavailableError extends BrokerUnavailableError {
  constructor(message = 'Alpaca is not reachable') {
    super(message);
    this.name = 'AlpacaUnavailableError';
  }
}

/**
 * Alpaca is throttling this key (HTTP 429; the free plan allows 200 requests a
 * minute). `retryAfterMs` is when it says to try again, if it said.
 */
export class AlpacaRateLimitError extends AlpacaUnavailableError {
  constructor(readonly retryAfterMs: number | undefined) {
    super('Alpaca is over its request limit for this key');
    this.name = 'AlpacaRateLimitError';
  }
}

/** Alpaca refused the key. Retrying will not help until it is replaced. */
export class AlpacaAuthError extends BrokerUnavailableError {
  constructor() {
    super('Alpaca refused the API key');
    this.name = 'AlpacaAuthError';
  }
}

/** Alpaca answered the request with an error of its own. */
export class AlpacaRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'AlpacaRequestError';
  }
}

type Query = Record<string, string | number | boolean | undefined>;

export class AlpacaClient {
  readonly tradingUrl: string;
  readonly dataUrl: string;
  private readonly fetch: Fetch;
  private readonly timeoutMs: number;
  private readonly headers: Record<string, string>;
  private readonly keyId: string;
  private readonly background: boolean;
  private readonly budget: AlpacaRequestBudget;

  constructor(options: AlpacaClientOptions) {
    this.tradingUrl = options.tradingUrl ?? ALPACA_PAPER_TRADING_URL;
    this.dataUrl = options.dataUrl ?? ALPACA_DATA_URL;
    assertPaperTradingUrl(this.tradingUrl, { allowLocal: options.allowLocal ?? false });
    assertDataUrl(this.dataUrl, { allowLocal: options.allowLocal ?? false });
    this.fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.keyId = options.credentials.keyId;
    this.background = options.background ?? false;
    this.budget = options.budget ?? sharedAlpacaBudget;
    this.headers = {
      'APCA-API-KEY-ID': options.credentials.keyId,
      'APCA-API-SECRET-KEY': options.credentials.secretKey,
      accept: 'application/json',
    };
  }

  /** Never print the key, whatever logs the client. */
  toJSON() {
    return { tradingUrl: this.tradingUrl, dataUrl: this.dataUrl };
  }

  [Symbol.for('nodejs.util.inspect.custom')]() {
    return `AlpacaClient(${this.tradingUrl})`;
  }

  trading<T>(method: string, path: string, options: { query?: Query; body?: unknown } = {}) {
    return this.request<T>(this.tradingUrl, method, path, options);
  }

  data<T>(path: string, query: Query = {}) {
    return this.request<T>(this.dataUrl, 'GET', path, { query });
  }

  private async request<T>(
    base: string,
    method: string,
    path: string,
    options: { query?: Query; body?: unknown },
  ): Promise<T> {
    const url = new URL(path, base);
    for (const [k, v] of Object.entries(options.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    await this.budget.take(this.keyId, this.background);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetch(url.toString(), {
        method,
        headers:
          options.body === undefined
            ? this.headers
            : { ...this.headers, 'content-type': 'application/json' },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: controller.signal,
      });
    } catch {
      throw new AlpacaUnavailableError(
        controller.signal.aborted ? 'Alpaca did not answer in time' : undefined,
      );
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 204) return undefined as T;
    const text = await response.text().catch(() => '');
    if (response.ok) {
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new AlpacaUnavailableError('Alpaca sent an unreadable reply');
      }
    }
    if (response.status === 401) throw new AlpacaAuthError();
    if (response.status === 429) {
      const after = retryAfter(response, Date.now());
      this.budget.throttled(this.keyId, after);
      throw new AlpacaRateLimitError(after);
    }
    if (response.status >= 500) throw new AlpacaUnavailableError();
    let code: number | undefined;
    let message = `Alpaca answered ${response.status}`;
    try {
      const body = JSON.parse(text) as { code?: unknown; message?: unknown };
      if (typeof body.code === 'number') code = body.code;
      if (typeof body.message === 'string' && body.message) message = body.message.slice(0, 200);
    } catch {
      // Keep the generic message.
    }
    throw new AlpacaRequestError(response.status, code, message);
  }
}

/** When a 429 says to try again: `Retry-After` seconds, or the `X-RateLimit-Reset` epoch second. */
export function retryAfter(response: Pick<Response, 'headers'>, nowMs: number): number | undefined {
  const after = Number(response.headers.get('retry-after'));
  if (Number.isFinite(after) && after > 0) return after * 1000;
  const reset = Number(response.headers.get('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) return Math.max(0, reset * 1000 - nowMs);
  return undefined;
}
