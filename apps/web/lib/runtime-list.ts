import type { RuntimeSummaryDto } from '@tm/contracts';

/**
 * The "Strategies on paper" list on Orders (N304): one row per run, every
 * column header sorts (N303) and filters. These are the filters, kept apart
 * from the page so they can be tested on their own.
 */

export type RuntimeView = 'list' | 'cards';
export const RUNTIME_VIEW_KEY = 'tm.orders.runtimeView';

/** Reads the remembered view; the list unless the cards were chosen. */
export function parseRuntimeView(saved: string | null | undefined): RuntimeView {
  return saved === 'cards' ? 'cards' : 'list';
}

export const RANGE_KEYS = [
  'completedToday',
  'todayPnl',
  'completed',
  'active',
  'rejected',
  'entering',
  'pnl',
  'winRate',
] as const;
export type RangeKey = (typeof RANGE_KEYS)[number];

export const PERIODS = [
  { value: '1d', label: 'Last 24 hours', ms: 86_400_000 },
  { value: '7d', label: 'Last 7 days', ms: 7 * 86_400_000 },
  { value: '30d', label: 'Last 30 days', ms: 30 * 86_400_000 },
  { value: 'older', label: 'Over 30 days ago', ms: 30 * 86_400_000 },
] as const;
export type Period = '' | (typeof PERIODS)[number]['value'];
/** The Last entry column can also ask for runs that have not entered yet. */
export type EntryPeriod = Period | 'none';

export interface RuntimeListFilters {
  number: string;
  strategy: string;
  status: '' | RuntimeSummaryDto['status'];
  started: Period;
  lastEntry: EntryPeriod;
  ranges: Record<RangeKey, { min: string; max: string }>;
}

export function emptyRuntimeFilters(): RuntimeListFilters {
  return {
    number: '',
    strategy: '',
    status: '',
    started: '',
    lastEntry: '',
    ranges: Object.fromEntries(RANGE_KEYS.map((k) => [k, { min: '', max: '' }])) as Record<
      RangeKey,
      { min: string; max: string }
    >,
  };
}

/** How many filters are set. */
export function countRuntimeFilters(f: RuntimeListFilters): number {
  let n = 0;
  if (f.number.trim()) n++;
  if (f.strategy.trim()) n++;
  if (f.status) n++;
  if (f.started) n++;
  if (f.lastEntry) n++;
  for (const k of RANGE_KEYS) if (f.ranges[k].min.trim() || f.ranges[k].max.trim()) n++;
  return n;
}

/** Share of completed cycles that closed with a gain, in percent; null before any. */
export function winRate(r: RuntimeSummaryDto): number | null {
  return r.cycles.completed > 0 ? (r.wins / r.cycles.completed) * 100 : null;
}

/** A column's number for a run, for the range filters. */
export function rangeValue(r: RuntimeSummaryDto, key: RangeKey): number | null {
  switch (key) {
    case 'completedToday':
      return r.completedToday;
    case 'todayPnl':
      return Number(r.today.pnl);
    case 'completed':
    case 'active':
    case 'rejected':
    case 'entering':
      return r.cycles[key];
    case 'pnl':
      return Number(r.realizedPnl);
    case 'winRate':
      return winRate(r);
  }
}

/** A typed bound: "$1,200", "-5", "40%" all read; empty is no bound; null if unreadable. */
export function parseBound(text: string): number | null | undefined {
  const t = text
    .trim()
    .replace(/[$,%\s]/g, '')
    .replace(/^−/, '-');
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function inPeriod(iso: string | null, period: EntryPeriod, now: number): boolean {
  if (!period) return true;
  if (period === 'none') return iso === null;
  if (iso === null) return false;
  const age = now - Date.parse(iso);
  const p = PERIODS.find((x) => x.value === period);
  if (!p) return true;
  return period === 'older' ? age > p.ms : age <= p.ms;
}

/** Whether a run passes every filter that is set. */
export function matchesRuntime(
  r: RuntimeSummaryDto,
  f: RuntimeListFilters,
  now: number = Date.now(),
): boolean {
  const number = f.number.trim().toLowerCase();
  if (number && !(r.strategyNumber ?? '').toLowerCase().includes(number)) return false;
  const name = f.strategy.trim().toLowerCase();
  if (name && !r.strategyName.toLowerCase().includes(name)) return false;
  if (f.status && r.status !== f.status) return false;
  if (!inPeriod(r.startedAt, f.started, now)) return false;
  if (!inPeriod(r.lastEntryAt, f.lastEntry, now)) return false;
  for (const k of RANGE_KEYS) {
    const min = parseBound(f.ranges[k].min);
    const max = parseBound(f.ranges[k].max);
    // An unreadable bound is ignored, so a half-typed "-" never empties the list.
    if (typeof min !== 'number' && typeof max !== 'number') continue;
    const v = rangeValue(r, k);
    if (v === null) return false;
    if (typeof min === 'number' && v < min) return false;
    if (typeof max === 'number' && v > max) return false;
  }
  return true;
}
