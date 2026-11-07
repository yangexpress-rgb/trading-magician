import {
  checkSec,
  fetchCompanyReport,
  fetchPointInTime,
  fetchScreenFacts,
  fetchTickers,
  normalizeTicker,
  SecClient,
  type Fetch,
  type SecListing,
} from '@tm/sec';
import type { ScreenFacts } from '@tm/domain';
import type { FundamentalsProvider, ProviderContext } from './providers';

/**
 * SEC EDGAR as a company data provider (ADR 0031). Filings are public, so the
 * ticker list and the screener's year of figures are kept once for every
 * tenant; each request still names the tenant's own contact, as the SEC asks.
 */
export interface SecProviderOptions {
  fetch?: Fetch | undefined;
  /** Tests and E2E only: a local fake in place of the SEC's hosts. */
  fake?: { wwwUrl: string; dataUrl: string } | undefined;
  /** Tests only: no spacing between requests. */
  spacingMs?: number | undefined;
}

/** The ticker list changes a few times a day at most. */
export const SEC_TICKERS_TTL_MS = 12 * 60 * 60 * 1000;
/** A year's figures only change as companies file; twice a day is plenty. */
export const SEC_SCREEN_TTL_MS = 12 * 60 * 60 * 1000;

interface Cached<T> {
  at: number;
  value: Promise<T>;
}

/** Keeps a promise for a while; a failed one is dropped so the next call tries again. */
function cache<T>(ttlMs: number) {
  let held: Cached<T> | undefined;
  return (nowMs: number, load: () => Promise<T>): Promise<T> => {
    if (!held || nowMs - held.at > ttlMs) {
      const value = load();
      held = { at: nowMs, value };
      value.catch(() => {
        if (held?.value === value) held = undefined;
      });
    }
    return held.value;
  };
}

export function secProvider(options: SecProviderOptions = {}): FundamentalsProvider {
  const clientFor = (ctx: Pick<ProviderContext, 'credential'>) => {
    const contact = ctx.credential?.fields.contactEmail;
    if (ctx.credential?.provider !== 'sec' || !contact) {
      throw new Error('No SEC contact is stored for this feed');
    }
    return new SecClient({
      credentials: { contactEmail: contact },
      fetch: options.fetch,
      spacingMs: options.spacingMs,
      ...(options.fake
        ? { wwwUrl: options.fake.wwwUrl, dataUrl: options.fake.dataUrl, allowLocal: true }
        : {}),
    });
  };
  const tickers = cache<Map<string, SecListing>>(SEC_TICKERS_TTL_MS);
  const screen = cache<{ year: number; facts: Map<string, ScreenFacts> }>(SEC_SCREEN_TTL_MS);
  const tickerMap = (client: SecClient, nowMs: number) =>
    tickers(nowMs, () => fetchTickers(client));

  return {
    needsCredential: true,
    check: async (ctx) => {
      await checkSec(clientFor(ctx));
      // Filings arrive as companies file them; nothing here is a live price.
      return { ok: true, entitlement: 'entitled', realtime: false };
    },
    report: async (ctx, symbol) => {
      const client = clientFor(ctx);
      const listing = (await tickerMap(client, ctx.now().getTime())).get(normalizeTicker(symbol));
      return listing ? fetchCompanyReport(client, listing) : undefined;
    },
    screenFacts: async (ctx) => {
      const client = clientFor(ctx);
      const nowMs = ctx.now().getTime();
      return screen(nowMs, async () =>
        fetchScreenFacts(client, await tickerMap(client, nowMs), ctx.now()),
      );
    },
    companies: async (ctx) => {
      const listings = await tickerMap(clientFor(ctx), ctx.now().getTime());
      const out = new Map<string, number>();
      for (const [symbol, l] of listings) out.set(symbol, Number(l.cik));
      return out;
    },
    pointInTime: (ctx, cik) => fetchPointInTime(clientFor(ctx), cik),
  };
}
