import type { ConfirmedInstrument, FeedCheckResult, OpenedCredential, Transaction } from '@tm/db';
import { DEMO_INSTRUMENTS } from '@tm/db';
import {
  addDays,
  nyDate,
  SCREEN_HISTORY_DAYS,
  type Bar,
  type CompanyReport,
  type CustomRestConfig,
  type FundamentalObservation,
  type HistoricalDataProvider,
  type LiveQuoteProvider,
  type ScreenDay,
  type ScreenFacts,
  type ScreenSource,
} from '@tm/domain';

/**
 * Market-data providers the worker can talk to (ADR 0016), keyed by the
 * provider id in the Settings catalog. A feed row picks one; its stored
 * credential, when the provider needs one, is opened only in memory.
 */
export interface ProviderContext {
  now: () => Date;
  credential?: OpenedCredential | undefined;
  /** The feed being used: custom REST feeds read their description from it (ADR 0041). */
  feed?: { id: string; config: CustomRestConfig | null } | undefined;
  /** The tenant, for providers that keep a cache and request counts in the database. */
  userId?: string | undefined;
  inTenant?: (<T>(fn: (tx: Transaction) => Promise<T>) => Promise<T>) | undefined;
}

/** What a provider found for a symbol, before it is registered. */
export type InstrumentListing = Omit<ConfirmedInstrument, 'provider'>;

export interface MarketDataProvider {
  quotes(ctx: ProviderContext): LiveQuoteProvider;
  /** Historical bars, for back tests and the indicators strategies read. */
  history(ctx: ProviderContext): HistoricalDataProvider;
  /** Finds a US stock or ETF by symbol; providers without real instruments omit it. */
  lookup?(ctx: ProviderContext, symbol: string): Promise<InstrumentListing | undefined>;
  /**
   * Listings for many exact symbols at once, e.g. the S&P 500 members a
   * Selection group ranks (v1.2 item 1); symbols the provider lacks are left out.
   */
  listings?(ctx: ProviderContext, symbols: readonly string[]): Promise<InstrumentListing[]>;
  /** The best few listings for a symbol or company name, as a person typed it. */
  search?(ctx: ProviderContext, query: string): Promise<InstrumentListing[]>;
  /**
   * Every US stock and ETF the feed covers, with a month of daily prices and
   * the latest trade, for the stock screener (ADR 0030).
   */
  screen?(ctx: ProviderContext, request?: ScreenRequest): Promise<ScreenResult>;
  /** A light call that proves the connection and the account's entitlement. */
  check(ctx: ProviderContext): Promise<FeedCheckResult>;
  needsCredential: boolean;
}

export interface ScreenRequest {
  /** Only these symbols, such as the S&P 500 members; every listing when absent. */
  symbols?: ReadonlySet<string> | undefined;
}

export interface ScreenResult {
  sources: ScreenSource[];
  warnings: string[];
}

export type ProviderRegistry = Partial<Record<string, MarketDataProvider>>;

/**
 * Company data providers (ADR 0031): profiles, reported financials and
 * filings per company, and a year's figures for the screener. They have no
 * prices and no routes; the tenant's oldest active company data feed is used.
 */
export interface FundamentalsProvider {
  needsCredential: boolean;
  check(ctx: ProviderContext): Promise<FeedCheckResult>;
  /** Undefined when the provider has no such company, e.g. an ETF. */
  report(ctx: ProviderContext, symbol: string): Promise<CompanyReport | undefined>;
  /** Figures for the screener, by symbol. */
  screenFacts(ctx: ProviderContext): Promise<{ year: number; facts: Map<string, ScreenFacts> }>;
  /** Company ids (SEC CIKs) by symbol, for point-in-time fundamentals (v1.2 item 6). */
  companies?(ctx: ProviderContext): Promise<Map<string, number>>;
  /** A company's point-in-time observations; undefined when it files no financials. */
  pointInTime?(ctx: ProviderContext, cik: number): Promise<FundamentalObservation[] | undefined>;
}

export type FundamentalsRegistry = Partial<Record<string, FundamentalsProvider>>;

/** The built-in demo feed: always reachable, simulated live prices and generated history. */
export function demoProvider(
  quotes: (now: () => Date) => LiveQuoteProvider,
  history: (now: () => Date) => HistoricalDataProvider,
): MarketDataProvider {
  return {
    needsCredential: false,
    quotes: ({ now }) => quotes(now),
    history: ({ now }) => history(now),
    check: async () => ({ ok: true, entitlement: 'entitled', realtime: true }),
    screen: async ({ now }) => ({ sources: await screenDemo(history(now), now()), warnings: [] }),
  };
}

const toDay = (b: Bar, date = nyDate(b.start)): ScreenDay => ({
  date,
  open: b.open.toNumber(),
  high: b.high.toNumber(),
  low: b.low.toNumber(),
  close: b.close.toNumber(),
  volume: b.volume.toNumber(),
});

/**
 * The demo instruments for the screener: finished daily bars, and today's
 * session so far from its finished 5-minute bars.
 */
export async function screenDemo(
  history: HistoricalDataProvider,
  now: Date,
): Promise<ScreenSource[]> {
  const today = nyDate(now);
  const from = addDays(today, -SCREEN_HISTORY_DAYS);
  return Promise.all(
    DEMO_INSTRUMENTS.map(async (i) => {
      const ask = (interval: '1d' | '5m', start: string) =>
        history.getBars({
          instrumentId: i.symbol,
          symbol: i.symbol,
          assetClass: i.assetClass,
          interval,
          from: start,
          to: today,
          adjustment: 'split_only',
          session: 'regular',
        });
      const [daily, minutes] = await Promise.all([ask('1d', from), ask('5m', today)]);
      const done = (b: Bar) => Date.parse(b.end) <= now.getTime();
      const days = daily.bars.filter(done).map((b) => toDay(b));
      const intraday = minutes.bars.filter(done);
      const first = intraday[0];
      const latest = intraday.at(-1);
      if (first && latest && days.at(-1)?.date !== today) {
        days.push({
          date: today,
          open: first.open.toNumber(),
          high: Math.max(...intraday.map((b) => b.high.toNumber())),
          low: Math.min(...intraday.map((b) => b.low.toNumber())),
          close: latest.close.toNumber(),
          volume: intraday.reduce((a, b) => a + b.volume.toNumber(), 0),
        });
      }
      return {
        symbol: i.symbol,
        name: i.displayName,
        assetClass: i.assetClass,
        exchange: 'DEMO',
        last: days.at(-1)?.close ?? null,
        lastAt: latest?.end ?? null,
        days,
      };
    }),
  );
}

/** Never let a provider call hang a pass. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
