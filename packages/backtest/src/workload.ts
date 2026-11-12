import type { StrategyDefinition } from '@tm/domain';
import { planSeries, type SeriesPlan } from './data';
import type { BacktestInputs } from './inputs';

/**
 * How much price data a back test would hold, estimated from its series plan
 * before any bar is loaded (ADR 0081, design v1.2 N232).
 *
 * Every bar is held in memory for the whole run (five Decimals and two ISO
 * strings, about 1.24 KB each), so the bar count sets the worker's memory. A
 * run past the limit crashed the worker part way through loading and was
 * retried until abandoned, about 55 minutes later, with no reason given
 * (diagnosis 2026-11-11). Refusing it up front gives the reason at once.
 */

/**
 * Most bars one back test may hold (estimated). The worker has a 2 GB heap.
 * In the diagnosis about 1.5 M loaded bars filled it, while 502 stocks with one
 * month of 5-minute bars (about 1.1 M estimated) completed at 1.4 GB.
 */
export const MAX_BACKTEST_BARS = 1_200_000;

/** Bars a regular NYSE session holds at each interval (for estimates only). */
const BARS_PER_DAY: Record<string, number> = {
  '1m': 390,
  '5m': 78,
  '15m': 26,
  '30m': 13,
  '1h': 7,
  '4h': 2,
  '1d': 1,
  '1w': 0.2,
};

/** About 252 trading days in 365 calendar days. */
function tradingDays(from: string, to: string): number {
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
  return Math.max(0, Math.round(days * (252 / 365)));
}

export interface IntervalWorkload {
  series: number;
  instruments: number;
  from: string;
  to: string;
  estimatedBars: number;
}

export interface Workload {
  series: number;
  estimatedBars: number;
  byInterval: Record<string, IntervalWorkload>;
}

/** Series counts, date ranges and estimated bars per interval of a run's plan. */
export function estimateWorkload(plans: readonly SeriesPlan[]): Workload {
  const byInterval: Record<string, IntervalWorkload> = {};
  const ids = new Map<string, Set<string>>();
  for (const p of plans) {
    const k = p.spec.interval;
    const e = (byInterval[k] ??= {
      series: 0,
      instruments: 0,
      from: p.from,
      to: p.to,
      estimatedBars: 0,
    });
    e.series++;
    const seen = ids.get(k) ?? new Set<string>();
    ids.set(k, seen.add(p.spec.instrumentId));
    e.instruments = seen.size;
    if (p.from < e.from) e.from = p.from;
    if (p.to > e.to) e.to = p.to;
    e.estimatedBars += Math.round(tradingDays(p.from, p.to) * (BARS_PER_DAY[k] ?? 1));
  }
  const estimatedBars = Object.values(byInterval).reduce((n, e) => n + e.estimatedBars, 0);
  return { series: plans.length, estimatedBars, byInterval };
}

const INTERVAL_WORDS: Record<string, string> = {
  '1m': '1-minute',
  '5m': '5-minute',
  '15m': '15-minute',
  '30m': '30-minute',
  '1h': 'hourly',
  '4h': '4-hour',
  '1d': 'daily',
  '1w': 'weekly',
};

const millions = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} million` : n.toLocaleString('en-US');

/**
 * Why a run's plan is too big to back test, or undefined when it fits. The
 * message names what drives the size so the user knows what to shorten.
 */
export function workloadProblem(
  plans: readonly SeriesPlan[],
  maxBars: number = MAX_BACKTEST_BARS,
): string | undefined {
  const w = estimateWorkload(plans);
  if (w.estimatedBars <= maxBars) return undefined;
  const [interval, biggest] = Object.entries(w.byInterval).sort(
    (a, b) => b[1].estimatedBars - a[1].estimatedBars,
  )[0] as [string, IntervalWorkload];
  const months = Math.max(
    1,
    Math.round((Date.parse(biggest.to) - Date.parse(biggest.from)) / (30.44 * 86_400_000)),
  );
  const n = biggest.instruments;
  const what = `${INTERVAL_WORDS[interval] ?? interval} bars for ${n.toLocaleString('en-US')} ${
    n === 1 ? 'instrument' : 'instruments'
  } over about ${months} month${months === 1 ? '' : 's'}`;
  return (
    `This back test needs about ${millions(w.estimatedBars)} price bars, mostly ${what}. ` +
    `A back test can hold up to ${millions(maxBars)}. ` +
    'Shorten the dates or test fewer stocks.'
  );
}

/**
 * Most bars one paper runtime may keep loaded (estimated, ADR 0087). The
 * runtime keeps its bars between passes and shares the worker's 2 GB heap
 * with back tests (up to MAX_BACKTEST_BARS), so it gets a smaller share.
 */
export const MAX_PAPER_BARS = 400_000;

/**
 * Bars a paper runtime keeps of a series (ADR 0087): what the rules read
 * back (offsets, indicator warm-up and metric look-backs, as `SeriesPlan.bars`
 * counts them) plus two sessions of bars, at least 5, so a missing bar or a
 * holiday never leaves the rules short. Older bars are let go after each load.
 * The S&P 500 keeps about 80 thousand bars per 5-minute series that reads the
 * latest bars, and about 130 thousand per daily series ranked by 12-month return.
 */
export function paperBarsKept(plan: Pick<SeriesPlan, 'spec' | 'bars'>): number {
  const need = plan.bars ?? 2;
  const perDay = Math.ceil(BARS_PER_DAY[plan.spec.interval] ?? 1);
  return need + Math.max(2 * perDay, 5);
}

/** The window a paper pass evaluates: today, on daily execution bars. */
export function paperEvaluationInputs(today: string): BacktestInputs {
  return {
    from: today,
    to: today,
    interval: '1d',
    adjustment: 'split_and_dividend',
  } as BacktestInputs;
}

/** Bars a paper runtime keeps loaded for a plan, by interval (ADR 0087). */
export function estimatePaperBars(plans: readonly SeriesPlan[]): {
  total: number;
  byInterval: Record<string, number>;
} {
  const byInterval: Record<string, number> = {};
  let total = 0;
  for (const p of plans) {
    const n = paperBarsKept(p);
    byInterval[p.spec.interval] = (byInterval[p.spec.interval] ?? 0) + n;
    total += n;
  }
  return { total, byInterval };
}

/**
 * Why a strategy is too big to run on paper, or undefined (ADR 0087).
 * `memberCount` is how many members its group has today (0 without a group).
 */
export function paperWorkloadProblem(
  def: StrategyDefinition,
  memberCount: number,
  today: string,
  maxBars: number = MAX_PAPER_BARS,
): string | undefined {
  // Only the count matters for the estimate, so stand-in ids do.
  const members = Array.from({ length: memberCount }, (_, i) => `member-${i}`);
  const w = estimatePaperBars(planSeries(def, paperEvaluationInputs(today), members));
  if (w.total <= maxBars) return undefined;
  const [interval] = Object.entries(w.byInterval).sort((a, b) => b[1] - a[1])[0] as [
    string,
    number,
  ];
  return (
    `Running this on paper would keep about ${millions(w.total)} price bars loaded, mostly ${
      INTERVAL_WORDS[interval] ?? interval
    } bars for ${memberCount.toLocaleString('en-US')} stocks. ` +
    `A paper run can keep up to ${millions(maxBars)}. ` +
    'Use a smaller group, longer bars, or rules that look back fewer bars.'
  );
}
