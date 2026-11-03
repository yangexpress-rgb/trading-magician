import {
  CHART_INTERVALS,
  CHART_RANGES,
  type ChartInterval,
  type ChartRange,
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
  /** Skip the screen from the last minute and ask the feed again. */
  fresh: z.boolean().optional(),
});
export type CreateStockScreenRequest = z.infer<typeof createStockScreenRequest>;

export interface StockScreenDto {
  id: string;
  status: 'pending' | 'ready' | 'failed';
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
  /** One tuple per symbol, columns in the order of `SCREEN_TEXT_COLUMNS`, `SCREEN_NUMBER_COLUMNS`, lastAt, instrumentId. */
  rows: ScreenRowTuple[] | null;
}
