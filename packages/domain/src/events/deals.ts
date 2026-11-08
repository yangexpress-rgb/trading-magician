import { nyDate } from '../market/calendar';

/**
 * Merger deals (free data feeds brief v1 §3, §5.3, ADR 0058): the app's own
 * tracker of announced acquisitions of listed companies, built from EDGAR
 * filings. One row per deal, its status changes kept as history.
 */

export const DEAL_STATUSES = ['announced', 'pending', 'closed', 'withdrawn'] as const;
export type DealStatus = (typeof DEAL_STATUSES)[number];
export const DEAL_CONSIDERATIONS = ['cash', 'stock', 'mixed', 'unknown'] as const;
export type DealConsideration = (typeof DEAL_CONSIDERATIONS)[number];
export type DealConfidence = 'high' | 'low';

/** Whether a deal in this status still produces a spread. */
export const isActiveDealStatus = (s: DealStatus) => s === 'announced' || s === 'pending';

/** One deal as the engine reads it. */
export interface DealSignal {
  dealId: string;
  /** When the announcing filing was accepted (ISO). */
  announcedAt: string;
  offerPrice: number | null;
  confidence: DealConfidence;
  /** Status changes after the announcement, oldest first: the new status from the day after `date`. */
  changes: readonly { date: string; status: DealStatus }[];
}

/** The deal's status on a bar dated `barDate`: a change takes effect the next trading day. */
export function dealStatusOn(deal: DealSignal, barDate: string): DealStatus {
  let status: DealStatus = 'announced';
  for (const c of deal.changes) {
    if (c.date >= barDate) break;
    status = c.status;
  }
  return status;
}

/** The target's latest deal known at `atMs` that was still active that day, or undefined. */
export function activeDealAt(
  deals: readonly DealSignal[] | undefined,
  atMs: number,
): DealSignal | undefined {
  if (!deals) return undefined;
  const barDate = nyDate(new Date(atMs));
  let found: DealSignal | undefined;
  for (const d of deals) {
    if (Date.parse(d.announcedAt) > atMs) continue;
    if (!isActiveDealStatus(dealStatusOn(d, barDate))) continue;
    if (!found || d.announcedAt > found.announcedAt) found = d;
  }
  return found;
}

/**
 * `(offer − close) ÷ close` (§4, §7.2). Null (undefined) without an offer
 * price, for a low-confidence parse, or without a close: a missing offer
 * price is never a zero spread.
 */
export function dealSpread(deal: DealSignal | undefined, close: number | undefined) {
  if (!deal || deal.confidence !== 'high' || deal.offerPrice === null) return undefined;
  if (close === undefined || !(close > 0)) return undefined;
  return Math.round(((deal.offerPrice - close) / close) * 1e10) / 1e10;
}

/** App-issued deal ids: D00001, D00002 … in announcement order. */
export const formatDealId = (n: number) => `D${String(n).padStart(5, '0')}`;
