import Decimal from 'decimal.js';
import { nyDate, tradingDaysBetween } from '../market/calendar';
import { activeDealAt, dealSpread, type DealSignal } from './deals';
import {
  nextScheduledEarnings,
  daysToNextEarningsDate,
  latestRelease,
  type EarningsSignal,
  type ScheduledEarnings,
} from './earnings';
import { rateOn, type RatePoint } from './rates';

/**
 * Event signals as strategies read them (free data feeds brief v1 §4, §6):
 * earnings, merger deals and the T-bill rate, each the latest known on or
 * before the bar. The metric ids are the contract between the registry,
 * back tests and paper runs.
 */

export const EVENT_METRIC_IDS = [
  'earnings.days_since_earnings',
  'earnings.sue_ts',
  'earnings.surprise_pct',
  'earnings.next_earnings_days',
  // The earnings window's look ahead (N189); not offered in the builder on its own.
  'earnings.next_date_days',
  'deals.spread_pct',
  'rates.tbill_3m',
] as const;
export type EventMetricId = (typeof EVENT_METRIC_IDS)[number];

export const isEventMetricId = (id: string): id is EventMetricId =>
  (EVENT_METRIC_IDS as readonly string[]).includes(id);

/** What a run loaded for the event metrics it reads, by instrument id. */
export interface EventData {
  earnings: ReadonlyMap<string, readonly EarningsSignal[]>;
  calendar: ReadonlyMap<string, readonly ScheduledEarnings[]>;
  deals: ReadonlyMap<string, readonly DealSignal[]>;
  rates: readonly RatePoint[];
  /** The first day the deal tracker's scans cover; absent before its first scan. */
  dealsFrom?: string | undefined;
}

export const emptyEventData = (): EventData => ({
  earnings: new Map(),
  calendar: new Map(),
  deals: new Map(),
  rates: [],
});

/** One event metric value, with the date of the record it came from, for the condition log. */
export interface EventPoint {
  value: Decimal;
  asOfDate: string;
  /** e.g. 'rebuilt' for earnings from the history rebuild, or the deal id. */
  note?: string;
}

const point = (value: number, asOfDate: string, note?: string): EventPoint => ({
  value: new Decimal(value),
  asOfDate,
  ...(note ? { note } : {}),
});

/**
 * An event metric for an instrument at `atMs` (a bar's end), or undefined
 * when unknown. `close` is the bar's unadjusted close, which the deal spread
 * compares the offer price with.
 */
export function eventPointAt(
  data: EventData | undefined,
  instrumentId: string,
  metric: string,
  atMs: number,
  close: number | undefined,
): EventPoint | undefined {
  if (!data) return undefined;
  const barDate = nyDate(new Date(atMs));
  switch (metric) {
    case 'earnings.days_since_earnings':
    case 'earnings.sue_ts':
    case 'earnings.surprise_pct': {
      const r = latestRelease(data.earnings.get(instrumentId), atMs);
      if (!r) return undefined;
      const note = r.source === 'rebuilt' ? 'rebuilt' : undefined;
      if (metric === 'earnings.days_since_earnings')
        return point(tradingDaysBetween(r.announcedDate, barDate), r.announcedDate, note);
      const v = metric === 'earnings.sue_ts' ? r.sue : r.surprisePct;
      return v === null ? undefined : point(v, r.announcedDate, note);
    }
    // The next earnings metrics are dated by the coming date they count to (N224).
    case 'earnings.next_earnings_days': {
      const d = nextScheduledEarnings(
        data.calendar.get(instrumentId),
        data.earnings.get(instrumentId),
        atMs,
      );
      return d === undefined ? undefined : point(d.days, d.date);
    }
    case 'earnings.next_date_days': {
      const d = daysToNextEarningsDate(
        data.calendar.get(instrumentId),
        data.earnings.get(instrumentId),
        atMs,
      );
      return d === undefined ? undefined : point(d.days, d.date, d.standIn ? 'edgar' : undefined);
    }
    case 'deals.spread_pct': {
      const deal = activeDealAt(data.deals.get(instrumentId), atMs);
      const s = dealSpread(deal, close);
      return s === undefined || !deal
        ? undefined
        : point(s, nyDate(new Date(deal.announcedAt)), deal.dealId);
    }
    case 'rates.tbill_3m': {
      const r = rateOn(data.rates, barDate);
      return r ? point(r.tbill3m, r.date) : undefined;
    }
    default:
      return undefined;
  }
}
