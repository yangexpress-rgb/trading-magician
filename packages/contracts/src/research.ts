import {
  CHART_INTERVALS,
  CHART_RANGES,
  type ChartInterval,
  type ChartRange,
  type CompanyReport,
  type LiveChainView,
  type OptionSignalSource,
  type OptionSignalValues,
  type ScreenRowTuple,
} from '@tm/domain';
import { z } from 'zod';
import type { InstrumentOptionDto } from './integrations';

// ---------------------------------------------------------------------------
// Quantitative Research: price charts (Design v1.0 §11; ADR 0029)

export const createPriceChartRequest = z.object({
  instrumentId: z.uuid(),
  interval: z.enum(CHART_INTERVALS),
  range: z.enum(CHART_RANGES),
});
export type CreatePriceChartRequest = z.infer<typeof createPriceChartRequest>;

/** `[startMs, open, high, low, close, volume]`, oldest first. */
export type ChartBar = [number, number, number, number, number, number];

export interface PriceChartDto {
  id: string;
  instrument: InstrumentOptionDto;
  interval: ChartInterval;
  range: ChartRange;
  /** Inclusive New York dates the chart covers. */
  from: string;
  to: string;
  status: 'pending' | 'ready' | 'failed';
  /** Why the chart could not be drawn, in words for the person. */
  message: string | null;
  /** The data feed that gave the prices, by its name in Settings › Data feeds. */
  source: string | null;
  warnings: string[];
  bars: ChartBar[] | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Quantitative Research: the stock screener (Design v1.0 §11; ADR 0030)

export const createStockScreenRequest = z.object({
  /** The S&P 500 members (quick), or every listing the feed covers. */
  universe: z.enum(['sp500', 'all']).optional(),
  /** Skip the screen from the last minute and ask the feed again. */
  fresh: z.boolean().optional(),
});
export type CreateStockScreenRequest = z.infer<typeof createStockScreenRequest>;

export interface StockScreenDto {
  id: string;
  status: 'pending' | 'ready' | 'failed';
  universe: 'sp500' | 'all';
  /** New York date of the session the screen calls today. */
  sessionDate: string | null;
  rowCount: number | null;
  /** Why the screen could not be made, in words for the person. */
  message: string | null;
  /** The data feed that gave the prices, by its name in Settings › Data feeds. */
  source: string | null;
  warnings: string[];
  createdAt: string;
  /** When the screen was last changed: once ready, when its prices were taken. */
  updatedAt: string;
}

export interface StockScreenDataDto extends StockScreenDto {
  /** One tuple per symbol, columns in the order of `SCREEN_TEXT_COLUMNS`, `SCREEN_PRICE_COLUMNS`, lastAt, instrumentId, `SCREEN_FUNDAMENTAL_COLUMNS`. */
  rows: ScreenRowTuple[] | null;
}

// ---------------------------------------------------------------------------
// Quantitative Research: company pages (Design v1.0 §11; ADR 0031)

export const createCompanyReportRequest = z.object({
  /** A US ticker, e.g. AAPL or BRK.B. */
  symbol: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z][A-Z0-9.-]{0,9}$/, 'Enter a US ticker'),
  /** Skip the report from the last 12 hours and ask the feed again. */
  fresh: z.boolean().optional(),
});
export type CreateCompanyReportRequest = z.infer<typeof createCompanyReportRequest>;

export interface CompanyReportDto {
  id: string;
  symbol: string;
  status: 'pending' | 'ready' | 'failed';
  /** Why the report could not be made, in words for the person. */
  message: string | null;
  /** The company data feed that answered, by its name in Settings › Data feeds. */
  source: string | null;
  report: CompanyReport | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Quantitative Research: options (options data brief v2 §7, §10 item 8; ADR 0048)

export const createOptionChainRequest = z.object({
  /** A US stock or ETF ticker, e.g. SPY or BRK.B. */
  symbol: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z][A-Z0-9.-]{0,9}$/, 'Enter a US ticker'),
});
export type CreateOptionChainRequest = z.infer<typeof createOptionChainRequest>;

/** A symbol's live chain: computed by the app, kept 15 minutes. */
export interface OptionChainDto {
  symbol: string;
  status: 'pending' | 'ready' | 'failed';
  message: string | null;
  /** The view; a previous one stays here while a refresh is pending. */
  view: LiveChainView | null;
  requestedAt: string;
  finishedAt: string | null;
  freshUntil: string | null;
}

/** A symbol's recorded daily options history (the daily recording, ADR 0047). */
export interface OptionHistoryDto {
  symbol: string;
  /** False when the symbol is not in the recorded universe (no history). */
  recorded: boolean;
  points: { date: string; iv30: number | null; source: OptionSignalSource }[];
  latest: { date: string; values: OptionSignalValues; source: OptionSignalSource } | null;
}

/** How far an event job has got (ADR 0058), for the Research views to say what the record covers. */
export interface EventJobStatusDto {
  job: string;
  status: 'pending' | 'running' | 'done' | 'skipped' | 'failed';
  coveredFrom: string | null;
  coveredTo: string | null;
  lastOkAt: string | null;
  note: string | null;
}

/** One reported release with its SUE, from the app's record of EDGAR filings (ADR 0058). */
export interface EarningsReleaseDto {
  fiscalQuarterEnd: string;
  announcedAt: string;
  announcedDate: string;
  timeKnown: boolean;
  reportedEps: number | null;
  estimatedEps: number | null;
  surprisePct: number | null;
  epsQMinus4: number | null;
  diffSd: number | null;
  sue: number | null;
  sueSource: 'rebuilt' | 'recorded' | null;
  filingUrl: string;
}

/** Research › Earnings for a symbol: its latest releases and the next scheduled date. */
export interface EarningsDto {
  symbol: string;
  releases: EarningsReleaseDto[];
  /** Null in EDGAR-only mode, or when nothing is scheduled. */
  next: { date: string; timeHint: string | null; provider: string } | null;
  /** 'edgar_only' unless the nightly calendar fetch has run. */
  calendar: 'edgar_only' | 'on';
  scan: EventJobStatusDto[];
}

/** One deal of the app's EDGAR tracker (ADR 0058). */
export interface DealDto {
  dealId: string;
  targetSymbol: string | null;
  targetName: string;
  acquirerName: string | null;
  announcedDate: string;
  offerPrice: number | null;
  consideration: 'cash' | 'stock' | 'mixed' | 'unknown';
  status: 'announced' | 'pending' | 'closed' | 'withdrawn';
  confidence: 'high' | 'low';
  parseNote: string | null;
  sourceFilingUrl: string;
  /** The target's latest stored close and the spread it gives; null when unknown. */
  close: number | null;
  closeDate: string | null;
  spreadPct: number | null;
}

export interface DealListDto {
  deals: DealDto[];
  scan: EventJobStatusDto[];
}
