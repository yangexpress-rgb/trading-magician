import type { ShortInterestRow } from '@tm/db';

/**
 * FINRA's Query API for consolidated short interest (N323, ADR 0111): OAuth2
 * client credentials (scope data.public.read), dataset
 * otcMarket/consolidatedShortInterest, partitioned by settlement date, at
 * most 5,000 rows a request. The client id and secret never leave the worker
 * and never appear in an error.
 */

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export const FINRA_API_URL = 'https://api.finra.org';
export const FINRA_TOKEN_URL = 'https://ews.fip.finra.org/fip/rest/ews/oauth2/access_token';
export const SHORT_INTEREST_DATASET = { group: 'otcMarket', name: 'consolidatedShortInterest' };
const PAGE = 5000;

export class FinraError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FinraError';
  }
}

export interface FinraClient {
  /** The settlement dates FINRA has published, ascending. */
  settlementDates(): Promise<string[]>;
  /** Every row of one settlement date. */
  settlement(date: string): Promise<ShortInterestRow[]>;
}

export interface FinraClientOptions {
  clientId: string;
  clientSecret: string;
  apiUrl?: string | undefined;
  tokenUrl?: string | undefined;
  fetch?: Fetch | undefined;
  now?: () => number;
  /** Rows a request (FINRA allows 5,000). */
  pageSize?: number;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const numOrNull = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** One FINRA JSON row as the app stores it; undefined for a row without a symbol, date or position. */
export function parseFinraRow(raw: unknown): ShortInterestRow | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const symbol = typeof r.symbolCode === 'string' ? r.symbolCode.trim() : '';
  const settlementDate = typeof r.settlementDate === 'string' ? r.settlementDate : '';
  const shortShares = numOrNull(r.currentShortPositionQuantity);
  if (!symbol || !DATE.test(settlementDate) || shortShares === null) return undefined;
  return {
    symbol,
    settlementDate,
    shortShares,
    previousShortShares: numOrNull(r.previousShortPositionQuantity),
    changeShares: numOrNull(r.changePreviousNumber),
    avgDailyVolume: numOrNull(r.averageDailyVolumeQuantity),
    daysToCover: numOrNull(r.daysToCoverQuantity),
    revisionFlag: typeof r.revisionFlag === 'string' && r.revisionFlag ? r.revisionFlag : null,
  };
}

export function finraClient(o: FinraClientOptions): FinraClient {
  const fetchFn: Fetch = o.fetch ?? ((url, init) => fetch(url, init));
  const api = o.apiUrl ?? FINRA_API_URL;
  const tokenUrl = o.tokenUrl ?? FINRA_TOKEN_URL;
  const now = o.now ?? Date.now;
  const pageSize = o.pageSize ?? PAGE;
  let token: { value: string; until: number } | undefined;

  async function call(url: string, init: RequestInit, what: string): Promise<Response> {
    let res: Response;
    try {
      res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(60_000) });
    } catch {
      throw new FinraError(`FINRA did not answer (${what})`);
    }
    return res;
  }

  async function bearer(): Promise<string> {
    if (token && token.until > now()) return token.value;
    const basic = Buffer.from(`${o.clientId}:${o.clientSecret}`).toString('base64');
    const res = await call(
      `${tokenUrl}?grant_type=client_credentials`,
      { method: 'POST', headers: { authorization: `Basic ${basic}`, accept: 'application/json' } },
      'token',
    );
    if (res.status === 400 || res.status === 401 || res.status === 403)
      throw new FinraError('FINRA refused the API credential');
    if (!res.ok) throw new FinraError(`FINRA's token endpoint answered ${res.status}`);
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: unknown;
      expires_in?: unknown;
    };
    if (typeof body.access_token !== 'string' || !body.access_token)
      throw new FinraError('FINRA sent no access token');
    const seconds = Number(body.expires_in);
    const life = Number.isFinite(seconds) && seconds > 120 ? seconds : 1800;
    token = { value: body.access_token, until: now() + (life - 60) * 1000 };
    return token.value;
  }

  async function authed(path: string, init: RequestInit, what: string): Promise<Response> {
    const headers = {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${await bearer()}`,
    };
    let res = await call(`${api}${path}`, { ...init, headers }, what);
    if (res.status === 401) {
      // An expired token: one fresh try.
      token = undefined;
      res = await call(
        `${api}${path}`,
        { ...init, headers: { ...headers, authorization: `Bearer ${await bearer()}` } },
        what,
      );
    }
    if (res.status === 401 || res.status === 403)
      throw new FinraError('FINRA refused the API credential');
    if (res.status === 429) throw new FinraError('FINRA is over its rate limit');
    return res;
  }

  const { group, name } = SHORT_INTEREST_DATASET;
  return {
    async settlementDates() {
      const res = await authed(
        `/partitions/group/${group}/name/${name}`,
        { method: 'GET' },
        'partitions',
      );
      if (!res.ok) throw new FinraError(`FINRA answered ${res.status} (partitions)`);
      const body = (await res.json().catch(() => ({}))) as {
        availablePartitions?: { partitions?: unknown[] }[];
      };
      const dates = (body.availablePartitions ?? [])
        .map((p) => p.partitions?.[0])
        .filter((d): d is string => typeof d === 'string' && DATE.test(d));
      return [...new Set(dates)].sort();
    },
    async settlement(date) {
      const out: ShortInterestRow[] = [];
      for (let offset = 0; ; offset += pageSize) {
        const res = await authed(
          `/data/group/${group}/name/${name}`,
          {
            method: 'POST',
            body: JSON.stringify({
              limit: pageSize,
              offset,
              compareFilters: [
                { compareType: 'EQUAL', fieldName: 'settlementDate', fieldValue: date },
              ],
            }),
          },
          `settlement ${date}`,
        );
        if (res.status === 204) break;
        if (!res.ok) throw new FinraError(`FINRA answered ${res.status} (settlement ${date})`);
        const page = (await res.json().catch(() => {
          throw new FinraError(`FINRA sent an unreadable reply (settlement ${date})`);
        })) as unknown;
        if (!Array.isArray(page)) throw new FinraError(`FINRA sent no rows (settlement ${date})`);
        for (const raw of page) {
          const row = parseFinraRow(raw);
          if (row && row.settlementDate === date) out.push(row);
        }
        if (page.length < pageSize) break;
      }
      return out;
    },
  };
}
