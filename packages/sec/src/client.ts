import { BrokerUnavailableError } from '@tm/domain';

/**
 * A small client for SEC EDGAR's public JSON (ADR 0031). EDGAR needs no key,
 * but the SEC asks every automated client to name itself and a contact in the
 * User-Agent, and to stay under ten requests a second; it answers 403 to
 * requests that don't. Requests are spaced out across the whole process, time
 * out, and fail with errors that never carry the contact.
 */

export const SEC_WWW_URL = 'https://www.sec.gov';
export const SEC_DATA_URL = 'https://data.sec.gov';
/** EDGAR full-text search (filings since 2001), used by the deal tracker (ADR 0058). */
export const SEC_EFTS_URL = 'https://efts.sec.gov';

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface SecCredentials {
  contactEmail: string;
}

export interface SecClientOptions {
  credentials: SecCredentials;
  fetch?: Fetch | undefined;
  wwwUrl?: string | undefined;
  dataUrl?: string | undefined;
  eftsUrl?: string | undefined;
  /** Tests only: allows a local fake in place of the SEC's hosts. */
  allowLocal?: boolean | undefined;
  timeoutMs?: number | undefined;
  /** Least time between two requests, for the SEC's fair-access limit. */
  spacingMs?: number | undefined;
}

/** EDGAR could not be reached, timed out or is throttling; try again later. */
export class SecUnavailableError extends BrokerUnavailableError {
  constructor(message = 'SEC EDGAR is not reachable') {
    super(message);
    this.name = 'SecUnavailableError';
  }
}

/** The SEC refused the request, which it does when the contact is missing or the rate too high. */
export class SecRefusedError extends Error {
  constructor() {
    super('SEC EDGAR refused the request');
    this.name = 'SecRefusedError';
  }
}

/** EDGAR has nothing at that address, e.g. a company with no XBRL financials. */
export class SecNotFoundError extends Error {
  constructor(what = 'EDGAR has no such record') {
    super(what);
    this.name = 'SecNotFoundError';
  }
}

/** The stored contact is not an email address. */
export class SecContactError extends Error {
  constructor() {
    super('The SEC contact is not an email address');
    this.name = 'SecContactError';
  }
}

const EMAIL = /^[^\s@<>()"]{1,64}@[^\s@<>()"]{1,190}\.[A-Za-z]{2,}$/;

/** Hosts the client may call; anything else is a mistake, not a provider. */
const SEC_HOSTS = new Set(['www.sec.gov', 'data.sec.gov', 'efts.sec.gov']);

function assertSecUrl(url: string, allowLocal: boolean) {
  const host = new URL(url).hostname;
  if (SEC_HOSTS.has(host)) return;
  if (allowLocal && (host === 'localhost' || host.endsWith('.test') || host === '127.0.0.1')) {
    return;
  }
  throw new Error(`Refusing to call ${host} as SEC EDGAR`);
}

// One queue for the whole process: every feed shares the SEC's limit per IP.
let nextSlot = 0;
async function waitTurn(spacingMs: number) {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + spacingMs;
  if (at > now) await new Promise((resolve) => setTimeout(resolve, at - now));
}

export class SecClient {
  readonly wwwUrl: string;
  readonly dataUrl: string;
  readonly eftsUrl: string;
  private readonly fetch: Fetch;
  private readonly timeoutMs: number;
  private readonly spacingMs: number;
  private readonly headers: Record<string, string>;

  constructor(options: SecClientOptions) {
    const contact = options.credentials.contactEmail.trim();
    if (!EMAIL.test(contact)) throw new SecContactError();
    this.wwwUrl = options.wwwUrl ?? SEC_WWW_URL;
    this.dataUrl = options.dataUrl ?? SEC_DATA_URL;
    this.eftsUrl = options.eftsUrl ?? SEC_EFTS_URL;
    assertSecUrl(this.wwwUrl, options.allowLocal ?? false);
    assertSecUrl(this.eftsUrl, options.allowLocal ?? false);
    assertSecUrl(this.dataUrl, options.allowLocal ?? false);
    this.fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.spacingMs = options.spacingMs ?? 125;
    this.headers = {
      'user-agent': `TradingMagician/1.0 (${contact})`,
      accept: 'application/json',
      'accept-encoding': 'gzip, deflate',
    };
  }

  /** Never print the contact, whatever logs the client. */
  toJSON() {
    return { dataUrl: this.dataUrl };
  }

  [Symbol.for('nodejs.util.inspect.custom')]() {
    return `SecClient(${this.dataUrl})`;
  }

  /** A file on www.sec.gov, such as the ticker list. */
  www<T>(path: string) {
    return this.get<T>(this.wwwUrl, path);
  }

  /** The data API on data.sec.gov: submissions, company facts, frames. */
  data<T>(path: string) {
    return this.get<T>(this.dataUrl, path);
  }

  /** EDGAR full-text search: www's `/LATEST/search-index` API on efts.sec.gov. */
  efts<T>(path: string) {
    return this.get<T>(this.eftsUrl, path);
  }

  /** A filing document on www.sec.gov as text (HTML or plain), for the deal parser. */
  async document(path: string): Promise<string> {
    return this.get<string>(this.wwwUrl, path, 'text');
  }

  private async get<T>(base: string, path: string, as: 'json' | 'text' = 'json'): Promise<T> {
    await waitTurn(this.spacingMs);
    const url = new URL(path, base).toString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    let text: string;
    try {
      response = await this.fetch(url, {
        method: 'GET',
        headers: as === 'text' ? { ...this.headers, accept: 'text/html, text/plain' } : this.headers,
        signal: controller.signal,
      });
      text = await response.text();
    } catch {
      throw new SecUnavailableError(
        controller.signal.aborted ? 'SEC EDGAR did not answer in time' : undefined,
      );
    } finally {
      clearTimeout(timer);
    }
    if (response.ok) {
      if (as === 'text') return text as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new SecUnavailableError('SEC EDGAR sent an unreadable reply');
      }
    }
    if (response.status === 404) throw new SecNotFoundError();
    if (response.status === 403) throw new SecRefusedError();
    if (response.status === 429 || response.status >= 500) throw new SecUnavailableError();
    throw new SecUnavailableError(`SEC EDGAR answered ${response.status}`);
  }
}

/** A CIK as EDGAR's file names want it: ten digits. */
export const paddedCik = (cik: string | number) => String(cik).replace(/\D/g, '').padStart(10, '0');
