import { CHART_INTERVALS, CHART_RANGES, type ChartInterval, type ChartRange } from '@tm/domain';
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
