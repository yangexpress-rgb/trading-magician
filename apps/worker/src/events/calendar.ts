import { addDays } from '@tm/domain';
import type { CalendarRow } from '@tm/db';

/**
 * The forward earnings calendar (free data feeds brief v1 D1, §5.1, ADR
 * 0058): FMP free first, Finnhub free as the fallback, range-based (one
 * call per date window, never per symbol). Convenience data for a
 * prototype: kept server-side, never shown raw, behind the
 * EARNINGS_CALENDAR_PROVIDER kill switch. Keys never leave the worker.
 */

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;
export type CalendarProviderId = 'fmp' | 'finnhub';

export const FMP_URL = 'https://financialmodelingprep.com';
export const FINNHUB_URL = 'https://finnhub.io';

/** Days ahead the calendar covers, fetched in windows the free tiers accept. */
export const CALENDAR_DAYS = 90;
const WINDOW_DAYS = 30;

export class CalendarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalendarError';
  }
}

export interface CalendarSource {
  provider: CalendarProviderId;
  fetchRange(from: string, to: string): Promise<CalendarRow[]>;
}

const hint = (v: unknown): 'bmo' | 'amc' | null =>
  v === 'bmo' || v === 'amc' ? v : null;
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SYMBOL = /^[A-Z][A-Z0-9.\-]{0,9}$/;

async function getJson(fetchFn: Fetch, url: string, who: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      headers: { accept: 'application/json', 'user-agent': 'TradingMagician/1.0' },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new CalendarError(`${who} did not answer`);
  }
  // Never echo the URL: it carries the key.
  if (res.status === 401 || res.status === 403) throw new CalendarError(`${who} refused the key`);
  if (res.status === 429) throw new CalendarError(`${who} is over its free-tier limit`);
  if (!res.ok) throw new CalendarError(`${who} answered ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new CalendarError(`${who} sent an unreadable reply`);
  }
}

/** One row per symbol and date; malformed rows are dropped. */
function rows(list: unknown[], pick: (r: Record<string, unknown>) => CalendarRow): CalendarRow[] {
  const out = new Map<string, CalendarRow>();
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const r = pick(raw as Record<string, unknown>);
    if (!SYMBOL.test(r.symbol) || !DATE.test(r.date)) continue;
    out.set(`${r.symbol}|${r.date}`, r);
  }
  return [...out.values()];
}

export function fmpCalendar(o: { apiKey: string; fetch?: Fetch; baseUrl?: string }): CalendarSource {
  const fetchFn = o.fetch ?? ((url, init) => fetch(url, init));
  const base = o.baseUrl ?? FMP_URL;
  return {
    provider: 'fmp',
    async fetchRange(from, to) {
      const q = new URLSearchParams({ from, to, apikey: o.apiKey });
      const body = await getJson(fetchFn, `${base}/stable/earnings-calendar?${q.toString()}`, 'FMP');
      if (!Array.isArray(body)) throw new CalendarError('FMP sent no calendar');
      return rows(body, (r) => ({
        symbol: String(r.symbol ?? '').replace(/-/g, '.'),
        date: String(r.date ?? ''),
        timeHint: hint(r.time),
        estimatedEps: num(r.epsEstimated),
      }));
    },
  };
}

export function finnhubCalendar(o: {
  apiKey: string;
  fetch?: Fetch;
  baseUrl?: string;
}): CalendarSource {
  const fetchFn = o.fetch ?? ((url, init) => fetch(url, init));
  const base = o.baseUrl ?? FINNHUB_URL;
  return {
    provider: 'finnhub',
    async fetchRange(from, to) {
      const q = new URLSearchParams({ from, to, token: o.apiKey });
      const body = (await getJson(
        fetchFn,
        `${base}/api/v1/calendar/earnings?${q.toString()}`,
        'Finnhub',
      )) as { earningsCalendar?: unknown };
      if (!Array.isArray(body?.earningsCalendar)) throw new CalendarError('Finnhub sent no calendar');
      return rows(body.earningsCalendar, (r) => ({
        symbol: String(r.symbol ?? '').replace(/-/g, '.'),
        date: String(r.date ?? ''),
        timeHint: hint(r.hour),
        estimatedEps: num(r.epsEstimate),
      }));
    },
  };
}

/**
 * The next 90 days from the first source that answers (FMP, then Finnhub),
 * in 30-day windows. Throws only when every configured source fails.
 */
export async function fetchCalendar(
  sources: readonly CalendarSource[],
  today: string,
): Promise<{ provider: CalendarProviderId; rows: CalendarRow[] }> {
  let last: unknown;
  for (const s of sources) {
    try {
      const all: CalendarRow[] = [];
      for (let from = today; from < addDays(today, CALENDAR_DAYS); from = addDays(from, WINDOW_DAYS)) {
        const to = addDays(from, WINDOW_DAYS - 1);
        all.push(...(await s.fetchRange(from, to)));
      }
      return { provider: s.provider, rows: all };
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof Error ? last : new CalendarError('No earnings calendar is configured');
}

