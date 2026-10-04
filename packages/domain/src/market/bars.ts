import Decimal from 'decimal.js';
import type { BarInterval, MarketField, PriceAdjustment, Session } from '../strategy/catalog';

/**
 * Historical bars (Design v1.0 §7.1, §18 Phase 2). Prices are decimals so the
 * back tester and the runtime compute identical values.
 */
export interface Bar {
  /** Bar start and end as UTC ISO instants; a bar is usable only once `end` has passed. */
  start: string;
  end: string;
  open: Decimal;
  high: Decimal;
  low: Decimal;
  close: Decimal;
  volume: Decimal;
}

export interface BarRequest {
  instrumentId: string;
  symbol: string;
  assetClass: string;
  interval: BarInterval;
  /** Inclusive New York calendar dates, `YYYY-MM-DD`. */
  from: string;
  to: string;
  adjustment: PriceAdjustment;
  session: Session;
}

export interface BarSeries {
  bars: Bar[];
  /** Identifies the exact data returned, for back-test provenance (§7.2). */
  dataVersion: string;
  /** Data caveats to show beside results, e.g. a substituted session. */
  warnings: string[];
}

/**
 * Source of historical bars. Market-data providers sit behind this interface
 * (§21); the first implementation is the generated demo history.
 */
export interface HistoricalDataProvider {
  readonly id: string;
  readonly intervals: readonly BarInterval[];
  getBars(request: BarRequest): Promise<BarSeries>;
}

export class UnsupportedBarRequestError extends Error {}

/**
 * A bar field as a number series. Bars carry no quotes, so `last`, `bid`,
 * `ask` and `mid` read the close, and `vwap` the typical price; the back
 * tester reports that substitution as an assumption.
 */
export function barField(bar: Bar, field: MarketField): Decimal {
  switch (field) {
    case 'open':
      return bar.open;
    case 'high':
      return bar.high;
    case 'low':
      return bar.low;
    case 'volume':
      return bar.volume;
    case 'vwap':
      return bar.high.plus(bar.low).plus(bar.close).div(3);
    case 'close':
    case 'last':
    case 'bid':
    case 'ask':
    case 'mid':
      return bar.close;
  }
}

export const SUBSTITUTED_FIELDS: readonly MarketField[] = ['last', 'bid', 'ask', 'mid', 'vwap'];

export const d = (v: Decimal.Value) => new Decimal(v);
